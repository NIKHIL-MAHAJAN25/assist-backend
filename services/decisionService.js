const prisma = require('../config/prisma');

// "Does the family need to know?" — ai-prompting-patterns.md §3, decisions-log 2026-10-17.
//
// The rule-based answer (the perception module's requires_attention / the geofence rules) is always
// computed and is the fallback. Drex (Nace.AI) is asked the same question with the recent log as context.
//
// DECISION_MODE:
//   off    — rules only, Drex never called.
//   shadow — rules decide; Drex's answer is recorded next to them for comparison (default when a key is set).
//   live   — Drex decides; rules are used when Drex is slow, down or unsure.

const BASE_URL = (process.env.DREX_BASE_URL || 'https://drex.nace.ai').replace(/\/$/, '');
const MODEL = process.env.DREX_MODEL || 'drex-latest';
const TIMEOUT_MS = Number(process.env.DREX_TIMEOUT_MS || 6000);
const NOTIFY_THRESHOLD = 0.5;
const CONTEXT_ENTRIES = 6;

function mode() {
  if (!process.env.DREX_API_KEY) return 'off';
  const m = (process.env.DECISION_MODE || 'shadow').toLowerCase();
  return ['off', 'shadow', 'live'].includes(m) ? m : 'shadow';
}

// One line per log entry, in the words the family would use. Nothing identifying beyond the first name.
function describe(entry) {
  const p = entry.payload || {};
  const t = new Date(entry.timestamp).toTimeString().slice(0, 5);
  switch (entry.entryType) {
    case 'frame':
      return `${t} camera: ${p.activity || 'unknown'}${p.person_state ? ` (${p.person_state})` : ''}`;
    case 'geofence':
      return `${t} phone location: ${p.inside_safe_zone ? 'inside a safe place' : 'outside the safe places'}`;
    case 'heartrate':
      return `${t} heart rate ${p.bpm ?? '?'} bpm`;
    case 'quiz':
      return `${t} memory quiz answered`;
    case 'sighting':
      return `${t} sighting: ${p.note || p.activity || 'reported'}`;
    default:
      return `${t} ${entry.entryType}`;
  }
}

function buildRequest({ firstName, event, recent, ruleSaysNotify }) {
  return {
    model: MODEL,
    state: {
      person: `${firstName}, lives semi-independently with early-stage Alzheimer's; family checks in remotely`,
      local_time: new Date().toTimeString().slice(0, 5),
      new_event: event,
      earlier_today: recent,
      rule_based_flag: ruleSaysNotify,
    },
    questions: {
      notify: {
        type: 'noul',
        instructions:
          'Should the family be sent an alert about the new event right now? Say yes for falls, distress, ' +
          'leaving home alone at an unusual time, hazards (stove, open door at night), or a long absence. ' +
          'Say no for ordinary daily life, or when the same thing was already flagged moments ago.',
        criteria: {
          true: 'Safety risk or something the family would want to know immediately',
          false: 'Normal routine, or already known',
        },
      },
      urgency: {
        type: 'choice',
        instructions: 'How urgent is the new event?',
        criteria: {
          routine: 'Normal daily life, just log it',
          check_in: 'Worth a gentle check-in call later',
          act_now: 'Someone should act now',
        },
      },
    },
  };
}

// The hosted API's response shape isn't fully documented; accept the plausible variants.
function readNoul(a) {
  if (a == null) return null;
  if (typeof a === 'number') return a;
  if (typeof a === 'boolean') return a ? 1 : 0;
  const v = a.probability ?? a.p ?? a.yes ?? a.score ?? a.value ?? a.answer;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function readChoice(a) {
  if (a == null) return null;
  if (typeof a === 'string') return { choice: a, probabilities: null };
  const probabilities = a.probabilities || a.probs || a.distribution || null;
  let choice = a.choice ?? a.answer ?? a.label ?? a.value ?? null;
  if (!choice && probabilities && typeof probabilities === 'object') {
    choice = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  }
  return { choice, probabilities };
}

async function askDrex(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DREX_API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Drex HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const answers = json.answers || json.result?.answers || json;
    const notifyP = readNoul(answers.notify);
    const urgency = readChoice(answers.urgency);
    if (notifyP == null) throw new Error(`Drex answer not understood: ${text.slice(0, 200)}`);
    return { ok: true, notify_p: notifyP, urgency: urgency?.choice ?? null, urgency_p: urgency?.probabilities ?? null, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : err.message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function toAgentDecision(notify, urgency) {
  if (!notify) return urgency === 'check_in' ? 'check_in' : 'log_only';
  return 'alert_family';
}

// Decide for a log entry that has already been written. In shadow mode this runs after the
// HTTP response has gone out, so a slow Drex never delays the camera or the phone.
async function decide(entryId) {
  const entry = await prisma.logEntry.findUnique({ where: { id: entryId }, include: { patient: true } });
  if (!entry) return null;
  const ruleNotify = entry.requiresAttention;
  const m = mode();

  const record = { mode: m, rules: { notify: ruleNotify }, at: new Date().toISOString() };
  let finalNotify = ruleNotify;
  let finalUrgency = ruleNotify ? 'act_now' : 'routine';

  if (m !== 'off') {
    const since = new Date(new Date(entry.timestamp).getTime() - 6 * 3600 * 1000);
    const recent = await prisma.logEntry.findMany({
      where: { patientId: entry.patientId, timestamp: { gte: since, lt: entry.timestamp } },
      orderBy: { timestamp: 'desc' },
      take: CONTEXT_ENTRIES,
    });
    const firstName = (entry.patient?.name || 'The person').split(' ')[0];
    const drex = await askDrex(
      buildRequest({ firstName, event: describe(entry), recent: recent.reverse().map(describe), ruleSaysNotify: ruleNotify })
    );
    record.drex = drex.ok
      ? { notify: drex.notify_p >= NOTIFY_THRESHOLD, notify_p: Math.round(drex.notify_p * 1000) / 1000, urgency: drex.urgency, ms: drex.ms }
      : { error: drex.error, ms: drex.ms };
    record.agree = drex.ok ? record.drex.notify === ruleNotify : null;

    if (m === 'live' && drex.ok) {
      // Drex may raise any alert, but may only silence a rule alert from the camera, and only when
      // it is confident. Leaving the safe places is never silenced.
      const maySuppress = entry.entryType === 'frame' && drex.notify_p < 0.2;
      finalNotify = record.drex.notify || (ruleNotify && !maySuppress);
      finalUrgency = drex.urgency || (finalNotify ? 'act_now' : 'routine');
      record.decided_by = 'drex';
    } else {
      record.decided_by = 'rules';
    }
  } else {
    record.decided_by = 'rules';
  }

  await prisma.logEntry.update({
    where: { id: entry.id },
    data: {
      agentDecision: toAgentDecision(finalNotify, finalUrgency),
      requiresAttention: finalNotify,
      payload: { ...(entry.payload || {}), decision: record },
    },
  });
  return record;
}

// Fire-and-forget in off/shadow mode; awaited in live mode so the response reflects the decision.
async function decideFor(entryId) {
  if (mode() === 'live') return decide(entryId).catch((e) => console.error('[decision]', e.message));
  decide(entryId).catch((e) => console.error('[decision]', e.message));
  return null;
}

module.exports = { decideFor, decide, mode, describe, buildRequest, readNoul, readChoice };
