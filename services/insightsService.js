const prisma = require('../config/prisma');

// Looking back over what the system has seen (Batch D):
//   #20 "where did she leave her glasses?" — search the objects the camera noted on each moment
//   #22 doctor's report — two to four weeks of the journal's raw material, counted per day
// Both work only from stored log entries; nothing here calls an AI except the report's written note.

const QUIET = new Set(['empty_room', 'not_visible']);
const DAY = 86400000;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const hm = (d) => new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

// ---- #20 object recall ---------------------------------------------------------------------------

// Objects that are plural as one thing ("glasses" is not more than one "glass").
const ALWAYS_PLURAL = new Set(['glasses', 'spectacles', 'specs', 'scissors', 'trousers', 'pants', 'jeans', 'headphones', 'earphones', 'binoculars', 'slippers']);
const SAME_THING = {
  glasses: ['spectacles', 'specs'], spectacles: ['glasses'], phone: ['mobile', 'cell phone'], handbag: ['bag', 'purse'],
  purse: ['handbag', 'wallet'], wallet: ['purse'], remote: ['remote control'], stick: ['walking stick', 'cane'], cane: ['walking stick'],
};
const STOP = new Set(['my', 'her', 'his', 'their', 'the', 'a', 'an', 'where', 'did', 'she', 'he', 'they', 'leave', 'left', 'put', 'is', 'are', 'was', 'of', 'pair']);

/** "her reading glasses" → ["reading glasses", "glasses", "glass"] style terms, most specific first. */
function termsFor(q) {
  const words = String(q || '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.length) return [];
  const singular = (w) => (ALWAYS_PLURAL.has(w) ? w : w.endsWith('ses') || w.endsWith('xes') ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  // The whole phrase, then the object word itself (the last one: "reading glasses" → "glasses"),
  // never the describing words alone — "reading" would match "reading the newspaper".
  const head = words[words.length - 1];
  const out = new Set([words.join(' ')]);
  if (head.length >= 3) out.add(singular(head));
  for (const alt of SAME_THING[singular(head)] || []) out.add(alt);
  return [...out];
}

const objectsOf = (e) => (Array.isArray(e.payload?.objects_of_note) ? e.payload.objects_of_note.map(String) : []);

/**
 * Last sightings of an object on the home camera (newest first, one per ~10 minutes), from the
 * objects each moment noted and the moment's own description.
 */
async function findObject(patientId, query, { days = 7, limit = 3 } = {}) {
  const terms = termsFor(query);
  if (!terms.length) return { object: query, sightings: [] };
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchers = terms.map((term) => ({ term, re: new RegExp(`\\b${esc(term)}(e?s)?\\b`, 'i') }));
  const frames = await prisma.logEntry.findMany({
    where: { patientId, entryType: 'frame', timestamp: { gte: new Date(Date.now() - days * DAY) } },
    orderBy: { timestamp: 'desc' },
    take: 6000,
    select: { id: true, timestamp: true, payload: true, imagePublicId: true },
  });
  const sightings = [];
  for (const e of frames) {
    const objects = objectsOf(e);
    const hay = [...objects, e.payload?.activity || ''].map((s) => s.toLowerCase());
    const hit = matchers.find((m) => hay.some((h) => m.re.test(h)))?.term;
    if (!hit) continue;
    const last = sightings[sightings.length - 1];
    if (last && new Date(last.at) - e.timestamp < 10 * 60000) {
      // Same visit: keep the newest, but prefer one that has a photo.
      if (!last.image_public_id && e.imagePublicId) Object.assign(last, { image_public_id: e.imagePublicId, log_entry_id: e.id });
      continue;
    }
    sightings.push({
      log_entry_id: e.id,
      at: e.timestamp,
      matched: objects.find((o) => new RegExp(`\\b${esc(hit)}`, 'i').test(o)) || hit,
      objects,
      activity: e.payload?.activity || null,
      image_public_id: e.imagePublicId,
    });
    if (sightings.length >= limit) break;
  }
  return { object: query, terms, sightings };
}

/** One line per object the camera noticed recently, with when it was last seen — for the Assistant. */
async function recentObjects(patientId, { days = 3, max = 40 } = {}) {
  const frames = await prisma.logEntry.findMany({
    where: { patientId, entryType: 'frame', timestamp: { gte: new Date(Date.now() - days * DAY) } },
    orderBy: { timestamp: 'desc' },
    take: 3000,
    select: { timestamp: true, payload: true },
  });
  const seen = new Map();
  const today = startOfDay(new Date());
  for (const e of frames) {
    for (const o of objectsOf(e)) {
      const k = o.toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      const when = e.timestamp >= today ? `today ${hm(e.timestamp)}` : e.timestamp >= today - DAY ? `yesterday ${hm(e.timestamp)}` : e.timestamp.toLocaleDateString('en-GB', { weekday: 'short' }) + ` ${hm(e.timestamp)}`;
      seen.set(k, `${o} — ${when}${e.payload?.activity ? ` (${e.payload.activity})` : ''}`);
      if (seen.size >= max) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

// ---- #22 doctor's report ---------------------------------------------------------------------------

/** Groups frames of the same activity within `gapMin` into visits ("moments"). */
function visits(frames, keys, gapMin = 30) {
  const out = [];
  for (const f of frames) {
    const k = f.payload?.activity_key;
    if (!keys.has(k)) continue;
    const last = out[out.length - 1];
    if (last && last.key === k && f.timestamp - last.end <= gapMin * 60000) last.end = f.timestamp;
    else out.push({ key: k, start: f.timestamp, end: f.timestamp });
  }
  return out;
}

async function buildReport(patientId, days = 14) {
  days = [7, 14, 28].includes(Number(days)) ? Number(days) : 14;
  const to = new Date();
  const from = startOfDay(new Date(to.getTime() - (days - 1) * DAY));
  const [patient, entries, attempts, events, historyDevice] = await Promise.all([
    prisma.patient.findUnique({ where: { id: patientId }, select: { name: true, dob: true } }),
    prisma.logEntry.findMany({
      where: { patientId, timestamp: { gte: from, lte: to }, entryType: { in: ['frame', 'geofence'] } },
      orderBy: { timestamp: 'asc' },
      select: { entryType: true, timestamp: true, payload: true, requiresAttention: true, deviceId: true },
    }),
    prisma.quizAttempt.findMany({ where: { timestamp: { gte: from, lte: to }, quizQuestion: { patientId } }, select: { timestamp: true, correct: true } }),
    prisma.familyEvent.findMany({ where: { patientId, createdAt: { gte: from, lte: to }, kind: { in: ['fall_check', 'fall_escalated'] } }, select: { kind: true, createdAt: true } }),
    prisma.device.findFirst({ where: { patientId, identifier: 'demo:history' }, select: { id: true } }),
  ]);

  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * DAY);
    byDay.set(dayKey(d), { date: dayKey(d), frames: [], pings: [], quiz_total: 0, quiz_correct: 0, fall_checks: 0, fall_escalated: 0 });
  }
  for (const e of entries) {
    const b = byDay.get(dayKey(e.timestamp));
    if (!b) continue;
    (e.entryType === 'frame' ? b.frames : b.pings).push(e);
  }
  for (const a of attempts) {
    const b = byDay.get(dayKey(a.timestamp));
    if (b) { b.quiz_total += 1; b.quiz_correct += a.correct ? 1 : 0; }
  }
  for (const ev of events) {
    const b = byDay.get(dayKey(ev.createdAt));
    if (b) b[ev.kind === 'fall_check' ? 'fall_checks' : 'fall_escalated'] += 1;
  }

  const daily = [...byDay.values()].map((b) => {
    const person = b.frames.filter((f) => f.payload?.activity_key && !QUIET.has(f.payload.activity_key));
    const awake = person.filter((f) => f.payload.activity_key !== 'sleeping');
    const meals = visits(b.frames, new Set(['eating']));
    const meds = visits(b.frames, new Set(['taking_medication']));
    const rest = visits(b.frames, new Set(['resting', 'sleeping']));
    const daytimeRestMin = rest
      .filter((v) => v.start.getHours() >= 10 && v.start.getHours() < 19)
      .reduce((s, v) => s + Math.max(5, (v.end - v.start) / 60000), 0);
    let leftSafe = 0;
    let outsideMin = 0;
    let prev = null;
    for (const p of b.pings) {
      const out = p.payload?.inside_safe_zone === false;
      if (out && (!prev || prev.payload?.inside_safe_zone !== false)) leftSafe += 1;
      if (out && prev && prev.payload?.inside_safe_zone === false) outsideMin += Math.min(15, (p.timestamp - prev.timestamp) / 60000);
      prev = p;
    }
    return {
      date: b.date,
      recorded: b.frames.length > 0 || b.pings.length > 0,
      first_up: awake[0]?.timestamp || null,
      last_seen: person[person.length - 1]?.timestamp || null,
      meals: meals.length,
      medication: meds.length,
      daytime_rest_min: Math.round(daytimeRestMin),
      left_safe_places: leftSafe,
      outside_min: Math.round(outsideMin),
      falls: b.frames.filter((f) => f.payload?.activity_key === 'fallen').length ? Math.max(1, b.fall_checks) : b.fall_checks,
      fall_escalated: b.fall_escalated,
      distressed: visits(b.frames, new Set(['distressed'])).length,
      quiz_total: b.quiz_total,
      quiz_correct: b.quiz_correct,
    };
  });

  const recorded = daily.filter((d) => d.recorded);
  const sum = (k) => daily.reduce((s, d) => s + d[k], 0);
  const avg = (k) => (recorded.length ? Math.round((recorded.reduce((s, d) => s + d[k], 0) / recorded.length) * 10) / 10 : 0);
  const pct = (list) => {
    const t = list.reduce((s, d) => s + d.quiz_total, 0);
    return t ? Math.round((list.reduce((s, d) => s + d.quiz_correct, 0) / t) * 100) : null;
  };
  const half = Math.floor(daily.length / 2);
  const minutesOfDay = (d) => (d ? new Date(d).getHours() * 60 + new Date(d).getMinutes() : null);
  const avgTime = (k) => {
    // Today is only part of a day, so the usual times come from the days before it.
    const v = recorded.filter((d) => d.date !== dayKey(new Date())).map((d) => minutesOfDay(d[k])).filter((x) => x != null);
    if (!v.length) return null;
    const m = Math.round(v.reduce((s, x) => s + x, 0) / v.length);
    const d = new Date();
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return hm(d);
  };

  return {
    patient: { name: patient?.name, dob: patient?.dob },
    days,
    from,
    to,
    generated_at: new Date(),
    days_recorded: recorded.length,
    includes_simulated: Boolean(historyDevice && entries.some((e) => e.deviceId === historyDevice.id)),
    totals: {
      meals_per_day: avg('meals'),
      days_without_meal_seen: recorded.filter((d) => d.meals === 0 && d.date !== dayKey(new Date())).length,
      medication_days: recorded.filter((d) => d.medication > 0).length,
      daytime_rest_min_per_day: avg('daytime_rest_min'),
      usual_first_up: avgTime('first_up'),
      usual_last_seen: avgTime('last_seen'),
      left_safe_places: sum('left_safe_places'),
      outside_min: sum('outside_min'),
      falls: sum('falls'),
      fall_escalated: sum('fall_escalated'),
      distressed: sum('distressed'),
      quiz_pct: pct(daily),
      quiz_pct_first_half: pct(daily.slice(0, half)),
      quiz_pct_second_half: pct(daily.slice(half)),
    },
    daily,
  };
}

function reportPrompt(r) {
  const first = (r.patient.name || 'the patient').split(' ')[0];
  const t = r.totals;
  const today = dayKey(new Date());
  const lines = r.daily.map((d) =>
    `${d.date}${d.date === today ? ' (today, so far — the day is not over)' : ''}: ${d.recorded ? `up ${d.first_up ? hm(d.first_up) : '?'}, meals seen ${d.meals}, medication seen ${d.medication}, daytime rest ${d.daytime_rest_min} min, left safe places ${d.left_safe_places}x (${d.outside_min} min out), falls ${d.falls}${d.fall_escalated ? ' (needed help)' : ''}, distress ${d.distressed}, quiz ${d.quiz_total ? `${d.quiz_correct}/${d.quiz_total}` : 'not taken'}` : 'nothing recorded'}`
  ).join('\n');
  return `You are writing a short note for ${first}'s doctor from home-monitoring data (a home camera that
recognises activities, the phone's location, and a daily memory quiz). ${first} lives with memory loss.

Write 4–6 plain sentences covering the overall pattern of the last ${r.days} days: daily routine, eating,
medication, rest, leaving the safe places, falls, and the memory quiz trend. Be factual and specific with
numbers; note clear changes between the first and second half of the period. Do not diagnose, do not
recommend treatment, do not speculate beyond the data. Remember the camera only sees one room, so "not seen
eating" is not proof of not eating — say "not seen" rather than "did not".

Then a line "Worth discussing:" followed by 2–3 short bullet points ("- ...") of things the family might raise.

Reply with only the note.

Totals: meals seen per recorded day ${t.meals_per_day}; days with no meal seen ${t.days_without_meal_seen};
days medication seen ${t.medication_days}/${r.days_recorded}; usual first up ${t.usual_first_up}; usual last
seen ${t.usual_last_seen}; times left safe places ${t.left_safe_places} (${t.outside_min} min outside); falls ${t.falls}
(${t.fall_escalated} needed help); distress moments ${t.distressed}; quiz ${t.quiz_pct ?? 'n/a'}% (first half
${t.quiz_pct_first_half ?? 'n/a'}%, second half ${t.quiz_pct_second_half ?? 'n/a'}%).

Per day:
${lines}`;
}

module.exports = { findObject, recentObjects, termsFor, buildReport, reportPrompt };
