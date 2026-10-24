const prisma = require('../config/prisma');
const journal = require('./journalService');
const { recentObjects } = require('./insightsService');
const { distanceMeters } = require('./geofenceService');

// What the patient's own phone asks the server about their day: "Ask me anything" (recall) and the
// daily memory quiz. Both are spoken to someone with memory loss, so they're built from the moments a
// person would actually remember (a meal, a visitor, a walk to the park, a message from family), never
// from raw readings: no clock times, no "the camera", no heart rate, no "sitting".

const QUIET = new Set(['empty_room', 'not_visible', 'unknown']);
const DAY_MS = 86400000;

const partOfDay = (d) => {
  const h = d.getHours();
  return h < 5 ? 'last night' : h < 12 ? 'this morning' : h < 17 ? 'this afternoon' : 'this evening';
};
const firstName = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '').trim();
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/**
 * Through the shared helper queue (services/jobQueue.js): the Claude and Codex workers answer first,
 * Gemini only if none does in time. "agent" jobs jump the queue — the patient is waiting. Throws if
 * nobody answered.
 */
async function ask(patientId, prompt) {
  const { enqueueAgent, waitFor } = require('./jobQueue');
  const job = await enqueueAgent({ patientId, prompt });
  const done = await waitFor(job.id, 45000);
  if (!done || done.status !== 'done' || !done.result?.text) throw new Error(done?.error || 'no helper answered in time');
  return done.result.text;
}

/**
 * Today's memorable moments, oldest first: [{ at, when, text, people }]. Repeats of the same activity
 * are merged; quiet frames, pacing about and readings are left out.
 */
async function moments(patientId) {
  const from = startOfDay();
  const [frames, pings, zones, commands] = await Promise.all([
    prisma.logEntry.findMany({ where: { patientId, entryType: 'frame', timestamp: { gte: from } }, orderBy: { timestamp: 'asc' }, select: { id: true, timestamp: true, payload: true } }),
    prisma.logEntry.findMany({ where: { patientId, entryType: 'geofence', timestamp: { gte: from } }, orderBy: { timestamp: 'asc' }, select: { id: true, timestamp: true, payload: true } }),
    prisma.geofenceZone.findMany({ where: { patientId } }),
    prisma.deviceCommand.findMany({ where: { patientId, createdAt: { gte: from }, createdBy: { not: 'system' }, type: { in: ['speak', 'voice', 'album', 'story'] } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const out = [];

  let last = null;
  for (const f of frames) {
    const p = f.payload || {};
    if (QUIET.has(p.activity_key) || !p.activity) continue;
    const people = (p.people || []).map((x) => firstName(x.name)).filter(Boolean);
    if (last && last.key === p.activity_key && f.timestamp - last.at < 45 * 60000) {
      for (const n of people) if (!last.people.includes(n)) last.people.push(n);
      continue;
    }
    last = { id: f.id, at: f.timestamp, key: p.activity_key, text: p.activity, people, objects: p.objects_of_note || [] };
    out.push(last);
  }

  // Places other than home they went to (first arrival at each).
  const visited = new Set();
  for (const g of pings) {
    const { lat, lng } = g.payload || {};
    if (!Number.isFinite(lat)) continue;
    const zone = zones.find((z) => distanceMeters(lat, lng, z.centerLat, z.centerLng) <= z.radiusMeters);
    if (!zone || /home/i.test(zone.name) || visited.has(zone.id)) continue;
    visited.add(zone.id);
    out.push({ id: g.id, at: g.timestamp, key: 'place', text: `went to ${zone.name}`, place: zone.name, people: [] });
  }

  for (const c of commands) {
    const who = c.senderName || 'Family';
    const what = c.type === 'album' ? 'sent some family photos to look at' : c.type === 'story' ? 'sent a bedtime story' : c.type === 'voice' ? 'sent a voice message' : `sent a message: "${c.payload?.text || ''}"`;
    out.push({ id: null, at: c.createdAt, key: 'message', text: `${who} ${what}`, sender: who, people: [] });
  }

  return out
    .sort((a, b) => a.at - b.at)
    .map((m) => ({ ...m, when: partOfDay(m.at) }));
}

const momentLine = (m) => `- ${m.when}: ${m.text}${m.people.length ? ` (with ${m.people.join(' and ')})` : ''}`;

// ---- Ask me anything --------------------------------------------------------------------------------

/** Answers the patient's own question about their day. Never throws: falls back to a plain answer. */
async function answerQuestion(patient, question) {
  const first = firstName(patient.name).split(' ')[0];
  const [day, objects, journalText] = await Promise.all([
    moments(patient.id).catch(() => []),
    recentObjects(patient.id, { days: 3, max: 30 }).catch(() => []),
    journal.readDay(patient.id).catch(() => ''),
  ]);

  const prompt = `You are the gentle voice on ${first}'s phone. ${first} has memory loss and just asked: "${question}"

Answer from the notes below only. Speak to ${first} directly ("you"), warmly, in one or two short sentences
that sound natural read aloud. Say "this morning", "a little while ago", "yesterday" — never clock times like
14:05, never mention cameras, logs, sensors, readings or heart rate. If something was seen with an object, you
may say where (e.g. "Your keys were on the kitchen table this morning."). If the notes don't say, kindly say
you're not sure and suggest asking family — never guess.

Today, the moments that matter (oldest first):
${day.length ? day.map(momentLine).join('\n') : '(nothing notable yet today)'}

Things noticed around the home (newest sighting of each, last 3 days):
${objects.length ? objects.join('\n') : '(none)'}

Today's full notes, for reference only:
${String(journalText).split('\n').filter((l) => !/Watch ·|heart rate|Camera · no one in view/.test(l)).slice(-40).join('\n') || '(empty)'}`;

  try {
    const text = String(await ask(patient.id, prompt)).trim().replace(/^"|"$/g, '');
    if (text) return text;
  } catch (e) {
    console.error('[recall]', e.message);
  }
  // No AI right now: still say something true and kind.
  const latest = day[day.length - 1];
  return latest
    ? `I can't think clearly right now, ${first}. Earlier, ${latest.when.replace('this ', 'this ')}, you ${latest.text.replace(/^(\w)/, (c) => c.toLowerCase())}.`
    : `I'm not sure right now, ${first}. Your family can help, or try asking me again in a moment.`;
}

// ---- Daily quiz -------------------------------------------------------------------------------------

const BAD_QUESTION = /\b\d{1,2}([:.]\d{2})?\s*(am|pm|o'?clock)?\b|camera|in front of|log|record|sensor|reading|heart|sitting|sit\b|seated|standing|lying|what time/i;

/** True if a stored or generated question is one we'd never want to ask. */
const badQuestion = (q) => BAD_QUESTION.test(q.question) || !q.correctAnswer && !q.correct_answer
  || String(q.correctAnswer ?? q.correct_answer).split(/\s+/).length > 4;

/** Gentle orientation questions that are always true, to top up a quiet day. */
async function orientation(patientId) {
  const now = new Date();
  const out = [
    { question: 'What day of the week is it today?', correct_answer: now.toLocaleDateString('en-GB', { weekday: 'long' }), source_log_entry_id: null },
    { question: 'What month are we in?', correct_answer: now.toLocaleDateString('en-GB', { month: 'long' }), source_log_entry_id: null },
  ];
  const faces = await prisma.enrolledFace.findMany({ where: { patientId }, select: { name: true } }).catch(() => []);
  for (const f of faces) {
    const rel = /\(([^)]+)\)\s*$/.exec(f.name)?.[1];
    if (rel) out.unshift({ question: `What is your ${rel.trim()}'s name?`, correct_answer: firstName(f.name), source_log_entry_id: null });
  }
  return out;
}

/** 3–4 questions for today: from today's moments where possible, topped up with orientation ones. */
async function quizFor(patient) {
  const first = firstName(patient.name).split(' ')[0];
  const day = await moments(patient.id);
  let fromDay = [];
  if (day.length) {
    const prompt = `Write up to 3 short memory questions for ${first}, who has memory loss, about their day today.
Use ONLY these moments (numbered):
${day.map((m, i) => `${i}. ${m.when}: ${m.text}${m.people.length ? ` (with ${m.people.join(' and ')})` : ''}`).join('\n')}

Rules:
- Ask about meaningful things: what they ate or drank, who visited, where they went, who sent a message, what they did.
- Use "this morning / this afternoon / this evening" — NEVER a clock time.
- Never mention a camera, being seen, sensors or the phone. Never ask about sitting, standing or lying down.
- The answer must be 1–3 everyday words a person could say aloud (e.g. "toast", "Sarah", "the park").
- Skip moments that would make a dull or confusing question. Fewer good questions beat more bad ones.
- "moment" is the number of the moment the question is about.

Reply with ONLY this JSON, no prose, no code fences:
{"questions":[{"question":"…","correct_answer":"…","moment":0}]}`;
    try {
      const raw = await ask(patient.id, prompt);
      const json = String(raw).match(/\{[\s\S]*\}/)?.[0] || '{}';
      fromDay = (JSON.parse(json).questions || [])
        .filter((q) => !badQuestion(q) && day[q.moment])
        .slice(0, 3)
        .map((q) => ({ question: q.question.trim(), correct_answer: q.correct_answer.trim(), source_log_entry_id: day[q.moment].id || null }));
    } catch (e) {
      console.error('[quiz]', e.message);
    }
  }
  const extra = (await orientation(patient.id)).filter((o) => !fromDay.some((q) => q.question === o.question));
  return [...fromDay, ...extra].slice(0, Math.max(3, Math.min(4, fromDay.length + 2)));
}

module.exports = { moments, answerQuestion, quizFor, badQuestion };
