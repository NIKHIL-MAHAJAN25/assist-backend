const prisma = require('../config/prisma');
const journal = require('./journalService');

// Demo kit: "two weeks of history" so the doctor's report, "this week" summaries, the walk replay and
// "where did she leave it" have something real-looking to work with on stage. Everything is written by
// the device `demo:history`, marked `simulated: true`, and removed by clearHistory() (not by the
// daily demo reset, so a rehearsal doesn't wipe it).
//
// The fortnight has a gentle, plausible drift for the report to notice: in the second week lunch is
// missed twice, daytime rest grows, one evening walk goes outside the safe places, a fall on day 5,
// and the quiz slips from mostly right to about half.

const DEVICE = 'demo:history';
const DAY = 86400000;

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

const SCENES = {
  waking: { activity_key: 'walking_around', activity: 'getting up and moving about', person_state: 'slow, a little sleepy', objects: ['dressing gown', 'slippers'] },
  breakfast: { activity_key: 'eating', activity: 'eating breakfast at the table', person_state: 'seated, calm', objects: ['bowl', 'tea cup', 'reading glasses'] },
  meds: { activity_key: 'taking_medication', activity: 'taking tablets with water', person_state: 'focused', objects: ['pill organiser', 'glass of water'] },
  tv: { activity_key: 'watching_tv', activity: 'watching television from the armchair', person_state: 'relaxed', objects: ['remote control', 'blanket'] },
  reading: { activity_key: 'reading', activity: 'reading the newspaper', person_state: 'seated, calm', objects: ['newspaper', 'reading glasses'] },
  lunch: { activity_key: 'eating', activity: 'eating lunch at the table', person_state: 'seated, calm', objects: ['plate', 'glass of water'] },
  rest: { activity_key: 'resting', activity: 'resting in the armchair', person_state: 'eyes closed, relaxed', objects: ['cushion', 'blanket'] },
  nap: { activity_key: 'sleeping', activity: 'dozing in the armchair', person_state: 'asleep', objects: ['blanket'] },
  cleaning: { activity_key: 'cleaning', activity: 'tidying the kitchen counter', person_state: 'busy', objects: ['cloth', 'handbag', 'keys'] },
  phone: { activity_key: 'on_phone', activity: 'talking on the phone', person_state: 'smiling', objects: ['phone', 'reading glasses'] },
  dinner: { activity_key: 'eating', activity: 'eating dinner at the table', person_state: 'seated, calm', objects: ['plate', 'spoon'] },
  leaving: { activity_key: 'getting_ready_to_leave', activity: 'putting on a coat by the door', person_state: 'purposeful', objects: ['coat', 'handbag', 'keys'] },
  evening: { activity_key: 'watching_tv', activity: 'watching television in the evening', person_state: 'relaxed', objects: ['remote control', 'tea cup'] },
  fall: { activity_key: 'fallen', activity: 'on the floor beside the armchair', person_state: 'on the floor, trying to get up', objects: ['armchair', 'walking stick'] },
};

async function historyDevice(patientId) {
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  return (await prisma.device.findFirst({ where: { patientId, identifier: DEVICE } }))
    || prisma.device.create({ data: { patientId, identifier: DEVICE, deviceType: 'watch', apiKeyHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10) } });
}

/** Moves a point `m` metres on a bearing (degrees). */
function offset(lat, lng, m, bearing) {
  const b = (bearing * Math.PI) / 180;
  return [lat + (m * Math.cos(b)) / 111320, lng + (m * Math.sin(b)) / (111320 * Math.cos((lat * Math.PI) / 180))];
}

async function seedHistory(patientId, days = 14) {
  days = Math.min(28, Math.max(3, Number(days) || 14));
  await clearHistory(patientId);
  const device = await historyDevice(patientId);
  const zones = await prisma.geofenceZone.findMany({ where: { patientId } });
  const home = zones[0] ? { lat: zones[0].centerLat, lng: zones[0].centerLng, r: zones[0].radiusMeters } : null;
  const rand = rng(patientId.split('').reduce((s, c) => s + c.charCodeAt(0), 0));
  const frames = [];
  const pings = [];
  const quiz = [];
  const falls = [];

  for (let ago = days; ago >= 1; ago--) {
    const day = new Date(Date.now() - ago * DAY);
    day.setHours(0, 0, 0, 0);
    const late = ago <= Math.ceil(days / 2); // the more recent half
    const at = (h, m) => new Date(day.getTime() + (h * 60 + m + Math.round((rand() - 0.5) * 30)) * 60000);
    const add = (scene, h, m, n = 3) => {
      const t0 = at(h, m);
      for (let i = 0; i < n; i++) frames.push({ scene, at: new Date(t0.getTime() + i * (3 + Math.round(rand() * 4)) * 60000) });
    };

    add('waking', late ? 8 : 7, late ? 5 : 35, 2);
    add('breakfast', late ? 8 : 7, late ? 30 : 55, 4);
    if (!late || rand() > 0.3) add('meds', late ? 8 : 8, 50, 2);
    add(rand() > 0.5 ? 'reading' : 'tv', 10, 0, 4);
    if (rand() > 0.6) add('cleaning', 11, 15, 2);
    const skipLunch = late && (ago === 2 || ago === 5);
    if (!skipLunch) add('lunch', 13, late ? 20 : 0, 4);
    add('rest', 14, 30, late ? 4 : 2);
    if (late) add('nap', 15, 15, 5);
    if (rand() > 0.5) add('phone', 16, 40, 2);
    add('dinner', 19, 0, 4);
    add('evening', 20, 15, 3);

    if (late && ago === 5) {
      add('fall', 15, 50, 2);
      falls.push(at(15, 52));
    }

    // Short walks: inside the safe places most days; one evening walk outside in the recent week.
    if (home) {
      const out = late && ago === 3;
      add('leaving', out ? 18 : 11, out ? 0 : 40, 2);
      const start = at(out ? 18 : 11, out ? 10 : 50);
      const bearing = rand() * 360;
      const steps = out ? 10 : 4;
      for (let i = 0; i <= steps; i++) {
        const dist = out ? (i <= steps / 2 ? i : steps - i) * 110 : Math.min(home.r * 0.6, 25 * i);
        const [lat, lng] = offset(home.lat, home.lng, dist, bearing + i * 6);
        pings.push({ at: new Date(start.getTime() + i * 4 * 60000), lat, lng, inside: dist <= home.r });
      }
    }

    // Memory quiz around 5 pm: 3 questions, mostly right in the first week, about half in the second.
    const right = late ? (rand() > 0.5 ? 2 : 1) : (rand() > 0.3 ? 3 : 2);
    quiz.push({ at: at(17, 0), right, total: 3 });
  }

  // Frames, as a helper would have saved them.
  const frameRows = frames.map(({ scene, at }) => {
    const s = SCENES[scene];
    return {
      patientId, deviceId: device.id, entryType: 'frame', timestamp: at,
      requiresAttention: scene === 'fall',
      payload: {
        activity_key: s.activity_key, activity: s.activity, person_state: s.person_state,
        objects_of_note: s.objects.filter(() => rand() > 0.25), confidence: 0.8 + rand() * 0.15,
        requires_attention: scene === 'fall', analysed_by: rand() > 0.5 ? 'claude' : 'codex', simulated: true,
      },
    };
  });
  // Location pings: the first ping outside is flagged, like the real geofence check.
  let prevInside = true;
  const pingRows = pings.map((p) => {
    const flagged = !p.inside && prevInside;
    prevInside = p.inside;
    return { patientId, deviceId: device.id, entryType: 'geofence', timestamp: p.at, requiresAttention: flagged, payload: { lat: p.lat, lng: p.lng, inside_safe_zone: p.inside, simulated: true } };
  });
  await prisma.logEntry.createMany({ data: [...frameRows, ...pingRows] });

  // Quiz questions hang off one of that day's frames so clearHistory can find them again.
  const anchors = await prisma.logEntry.findMany({ where: { deviceId: device.id, entryType: 'frame' }, select: { id: true, timestamp: true } });
  for (const q of quiz) {
    const anchor = anchors.find((a) => a.timestamp.toDateString() === q.at.toDateString());
    if (!anchor) continue;
    for (let i = 0; i < q.total; i++) {
      await prisma.quizQuestion.create({
        data: {
          patientId, date: q.at, sourceLogEntryId: anchor.id,
          question: ['What did you have for breakfast?', 'Who phoned you today?', 'What did you watch this morning?'][i],
          correctAnswer: ['Cereal and tea', 'Priya', 'The news'][i],
          attempts: { create: { answered: i < q.right ? 'right' : 'not sure', correct: i < q.right, timestamp: new Date(q.at.getTime() + i * 60000) } },
        },
      });
    }
  }
  for (const f of falls) {
    const anchor = anchors.find((a) => a.timestamp.toDateString() === f.toDateString());
    await prisma.familyEvent.create({ data: { patientId, kind: 'fall_check', severity: 'act', title: 'Possible fall — checked in (simulated)', body: 'Answered "I\'m okay" within a minute.', refId: anchor?.id, createdAt: f } });
  }

  // Bring the past days' journal files in line (for "this week" summaries and the helpers' context).
  for (let ago = Math.min(days, 7); ago >= 1; ago--) await journal.writeDay(patientId, new Date(Date.now() - ago * DAY)).catch(() => {});
  return { days, frames: frameRows.length, pings: pingRows.length, quiz_days: quiz.length, falls: falls.length };
}

async function clearHistory(patientId) {
  const device = await prisma.device.findFirst({ where: { patientId, identifier: DEVICE } });
  if (!device) return { removed: 0 };
  const entries = await prisma.logEntry.findMany({ where: { deviceId: device.id }, select: { id: true } });
  const ids = entries.map((e) => e.id);
  const questions = await prisma.quizQuestion.findMany({ where: { sourceLogEntryId: { in: ids } }, select: { id: true } });
  await prisma.quizAttempt.deleteMany({ where: { quizQuestionId: { in: questions.map((q) => q.id) } } });
  await prisma.quizQuestion.deleteMany({ where: { id: { in: questions.map((q) => q.id) } } });
  await prisma.familyEvent.deleteMany({ where: { patientId, refId: { in: ids } } });
  await prisma.logEntryFace.deleteMany({ where: { logEntryId: { in: ids } } }).catch(() => {});
  const r = await prisma.logEntry.deleteMany({ where: { deviceId: device.id } });
  for (let ago = 7; ago >= 1; ago--) await journal.writeDay(patientId, new Date(Date.now() - ago * DAY)).catch(() => {});
  return { removed: r.count };
}

async function hasHistory(patientId) {
  const device = await prisma.device.findFirst({ where: { patientId, identifier: DEVICE }, select: { id: true } });
  return device ? prisma.logEntry.count({ where: { deviceId: device.id } }) : 0;
}

module.exports = { seedHistory, clearHistory, hasHistory, DEVICE };
