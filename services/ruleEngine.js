const prisma = require('../config/prisma');
const { ACTIVITIES } = require('./prompts');

// "Tell me when…" rules (#8). A closed set of rule kinds the agent maps plain English onto; the
// scheduler evaluates every active rule against location pings and camera moments. Times are the
// server's local time (TZ=Asia/Kolkata in production).

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const QUIET = new Set(['empty_room', 'not_visible']);
const PERSON_ACTIVITY = (k) => k && !QUIET.has(k);
// "up" = any sign of her being up and about
const MATCHES = (rule, key) => (rule === 'up' ? PERSON_ACTIVITY(key) && key !== 'sleeping' : key === rule);
const ACTIVITY_WORD = { up: 'up and about', ...Object.fromEntries(Object.entries(ACTIVITIES).map(([k, v]) => [k, v.split(' (')[0].split(' or ')[0]])) };

const todayAt = (hhmm) => {
  const [, h, m] = HHMM.exec(hhmm);
  const d = new Date();
  d.setHours(Number(h), Number(m), 0, 0);
  return d;
};
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const firedToday = (rule) => rule.lastFiredAt && rule.lastFiredAt >= startOfToday();
const fmt = (hhmm) => {
  const d = todayAt(hhmm);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(':00', '');
};
const activityOk = (a) => a === 'up' || Boolean(ACTIVITIES[a]);

const KINDS = {
  arrives_home: {
    describe: 'when they get back inside the safe places (home)',
    params: '{}',
    validate: () => ({}),
    label: (p, n) => `Tell me when ${n} gets home`,
  },
  leaves_home: {
    describe: 'when they leave the safe places, optionally only after a time',
    params: '{"after":"HH:MM"?}',
    validate: (p) => (p.after && !HHMM.test(p.after) ? null : { ...(p.after && { after: p.after }) }),
    label: (p, n) => `Tell me if ${n} leaves the house${p.after ? ` after ${fmt(p.after)}` : ''}`,
  },
  not_seen_by: {
    describe: 'if the camera has NOT seen an activity by a time today (e.g. not eaten by 14:00; "up" = up and about)',
    params: '{"activity":"<activity_key or up>","by":"HH:MM"}',
    validate: (p) => (activityOk(p.activity) && HHMM.test(p.by || '') ? { activity: p.activity, by: p.by } : null),
    label: (p, n) => `Tell me if ${n} hasn't been ${p.activity === 'eating' ? 'seen eating' : `seen ${ACTIVITY_WORD[p.activity]}`} by ${fmt(p.by)}`,
  },
  still_at: {
    describe: 'if at a time the camera still shows an activity (e.g. still sleeping at 09:00)',
    params: '{"activity":"<activity_key>","at":"HH:MM"}',
    validate: (p) => (ACTIVITIES[p.activity] && HHMM.test(p.at || '') ? { activity: p.activity, at: p.at } : null),
    label: (p, n) => `Tell me if ${n} is still ${ACTIVITY_WORD[p.activity]} at ${fmt(p.at)}`,
  },
  seen: {
    describe: 'as soon as the camera sees an activity (e.g. taking medication)',
    params: '{"activity":"<activity_key or up>"}',
    validate: (p) => (activityOk(p.activity) ? { activity: p.activity } : null),
    label: (p, n) => `Tell me when ${n} is seen ${ACTIVITY_WORD[p.activity]}`,
  },
  quiet_for: {
    describe: 'if the camera sees no one moving for N minutes during the day (08:00–21:00)',
    params: '{"minutes":30-480}',
    validate: (p) => {
      const m = Math.round(Number(p.minutes));
      return m >= 30 && m <= 480 ? { minutes: m } : null;
    },
    label: (p, n) => `Tell me if there's no sign of ${n} for ${p.minutes >= 60 ? `${p.minutes / 60} hour${p.minutes > 60 ? 's' : ''}` : `${p.minutes} minutes`}`,
  },
};

/** Validate an agent/UI rule proposal → { kind, params, label, repeat } or null. */
function cleanRule(r, firstName) {
  const def = KINDS[r?.kind];
  if (!def) return null;
  const params = def.validate(r.params || r || {});
  if (!params) return null;
  return { kind: r.kind, params, repeat: r.repeat === 'daily' ? 'daily' : 'once', label: def.label(params, firstName) };
}

/** Did the rule happen since it was last checked? → message text, or null. */
async function evaluate(rule, first) {
  const p = rule.params || {};
  const since = rule.lastCheckedAt;
  const now = new Date();

  if (rule.kind === 'arrives_home' || rule.kind === 'leaves_home') {
    const [before, pings] = await Promise.all([
      prisma.logEntry.findFirst({ where: { patientId: rule.patientId, entryType: 'geofence', timestamp: { lt: since } }, orderBy: { timestamp: 'desc' } }),
      prisma.logEntry.findMany({ where: { patientId: rule.patientId, entryType: 'geofence', timestamp: { gte: since } }, orderBy: { timestamp: 'asc' } }),
    ]);
    // Where they were when we last looked — only if that reading is fresh. A location hours old says
    // nothing about now, and would make the first ping after a gap look like an arrival.
    const fresh = before && since - before.timestamp < 10 * 60000;
    let inside = fresh ? before.payload?.inside_safe_zone !== false : null;
    for (const e of pings) {
      const now_in = e.payload?.inside_safe_zone !== false;
      if (inside !== null && now_in !== inside) {
        if (rule.kind === 'arrives_home' && now_in) return `${first} is back inside the safe places (${e.timestamp.toTimeString().slice(0, 5)}).`;
        if (rule.kind === 'leaves_home' && !now_in && (!p.after || e.timestamp >= todayAt(p.after))) {
          return `${first} has left the safe places (${e.timestamp.toTimeString().slice(0, 5)}).`;
        }
      }
      inside = now_in;
    }
    return null;
  }

  if (rule.kind === 'seen') {
    const frames = await prisma.logEntry.findMany({ where: { patientId: rule.patientId, entryType: 'frame', timestamp: { gte: since } }, orderBy: { timestamp: 'asc' } });
    const hit = frames.find((f) => MATCHES(p.activity, f.payload?.activity_key));
    return hit ? `Camera: ${first} is ${hit.payload.activity || ACTIVITY_WORD[p.activity]} (${hit.timestamp.toTimeString().slice(0, 5)}).` : null;
  }

  if (rule.kind === 'not_seen_by') {
    if (now < todayAt(p.by) || firedToday(rule)) return null;
    const frames = await prisma.logEntry.findMany({ where: { patientId: rule.patientId, entryType: 'frame', timestamp: { gte: startOfToday() } }, select: { payload: true } });
    if (frames.some((f) => MATCHES(p.activity, f.payload?.activity_key))) return rule.repeat === 'once' ? 'done-quietly' : null;
    return `It's past ${fmt(p.by)} and ${first} hasn't been seen ${p.activity === 'eating' ? 'eating' : ACTIVITY_WORD[p.activity]} today.`;
  }

  if (rule.kind === 'still_at') {
    if (now < todayAt(p.at) || firedToday(rule)) return null;
    const last = await prisma.logEntry.findFirst({ where: { patientId: rule.patientId, entryType: 'frame', timestamp: { gte: startOfToday() } }, orderBy: { timestamp: 'desc' } });
    if (last?.payload?.activity_key === p.activity) return `It's ${fmt(p.at)} and ${first} is still ${ACTIVITY_WORD[p.activity]}.`;
    return rule.repeat === 'once' ? 'done-quietly' : null;
  }

  if (rule.kind === 'quiet_for') {
    const h = now.getHours();
    if (h < 8 || h >= 21) return null;
    if (rule.lastFiredAt && now - rule.lastFiredAt < p.minutes * 60000) return null;
    const last = await prisma.logEntry.findFirst({
      where: { patientId: rule.patientId, entryType: 'frame', timestamp: { gte: startOfToday() } },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true, payload: true },
    });
    const lastPerson = last && PERSON_ACTIVITY(last.payload?.activity_key) ? last.timestamp : null;
    const ref = lastPerson || new Date(Math.max(startOfToday().getTime() + 8 * 3600000, rule.createdAt.getTime()));
    if (now - ref >= p.minutes * 60000) return `No sign of ${first} on the camera for ${Math.round((now - ref) / 60000)} minutes.`;
    return null;
  }
  return null;
}

/** Check every active rule; record hits as family events. Returns the hits. */
async function runRules() {
  const rules = await prisma.watchRule.findMany({ where: { active: true } });
  const names = new Map();
  const hits = [];
  for (const rule of rules) {
    if (!names.has(rule.patientId)) {
      const pt = await prisma.patient.findUnique({ where: { id: rule.patientId }, select: { name: true } });
      names.set(rule.patientId, (pt?.name || 'They').split(' ')[0]);
    }
    const checkedAt = new Date();
    let text = null;
    try {
      text = await evaluate(rule, names.get(rule.patientId));
    } catch (e) {
      console.error('[rules]', rule.id, e.message);
    }
    if (text === 'done-quietly') {
      await prisma.watchRule.update({ where: { id: rule.id }, data: { active: false, lastCheckedAt: checkedAt } });
      continue;
    }
    if (!text) {
      await prisma.watchRule.update({ where: { id: rule.id }, data: { lastCheckedAt: checkedAt } });
      continue;
    }
    await prisma.$transaction([
      prisma.watchRule.update({
        where: { id: rule.id },
        data: { lastCheckedAt: checkedAt, lastFiredAt: checkedAt, firedCount: { increment: 1 }, active: rule.repeat === 'daily' },
      }),
      prisma.familyEvent.create({ data: { patientId: rule.patientId, kind: 'rule', severity: 'watch', title: text, body: `You asked: “${rule.label}”`, refId: rule.id } }),
    ]);
    hits.push({ rule: rule.label, text });
  }
  return hits;
}

/** For the agent's prompt. */
function describeKinds() {
  return Object.entries(KINDS).map(([k, d]) => `  - ${k}: ${d.describe}. params ${d.params}`).join('\n');
}

module.exports = { KINDS, cleanRule, evaluate, runRules, describeKinds };
