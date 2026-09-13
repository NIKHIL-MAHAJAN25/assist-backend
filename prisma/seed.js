require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../config/prisma');

// All zones and log entries below are placed around Indiranagar, Bangalore
// (~12.9716 N, 77.6412 E). Home, the park, and the corner shop are all within
// a couple hundred metres of each other so geofence matching actually resolves.
const HOME = { lat: 12.9716, lng: 77.6412 };
const PARK = { lat: 12.9733, lng: 77.6428 }; // ~250m NE of home
const SHOP = { lat: 12.9705, lng: 77.6401 }; // ~180m SW of home
// The "went missing" incident happens a few hundred metres further out, well
// outside every zone's radius.
const AWAY = { lat: 12.9695, lng: 77.6455 };

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000);
}

function daysAgoAt(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Small deterministic offset so points scattered around a location don't all
// land exactly on the center (still well within the zone radius).
function jitter(base, seed, metres = 15) {
  const angle = (seed * 137.5) % 360;
  const rad = (angle * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / 111320;
  const dLng = (metres * Math.sin(rad)) / (111320 * Math.cos((base.lat * Math.PI) / 180));
  return { lat: base.lat + dLat, lng: base.lng + dLng };
}

// Deterministic pseudo-random 128-dim embedding (not real face-api output,
// just a stable stand-in so seeding doesn't require hand-writing 128 floats).
function fakeEmbedding(seed) {
  let x = seed;
  const values = [];
  for (let i = 0; i < 128; i++) {
    x = Math.sin(x * 12.9898 + i * 78.233) * 43758.5453;
    values.push(Number(((x - Math.floor(x)) * 2 - 1).toFixed(6)));
  }
  return values;
}

function frame(patientId, deviceId, timestamp, { activity, objects, personState, confidence = 0.9, attention = false }) {
  return {
    patientId,
    deviceId,
    entryType: 'frame',
    timestamp,
    payload: {
      activity,
      objects_of_note: objects,
      person_state: personState,
      confidence,
      requires_attention: attention,
    },
    requiresAttention: attention,
    agentDecision: attention ? 'alert_family' : 'log_only',
  };
}

function geofence(patientId, deviceId, timestamp, { lat, lng, insideSafeZone, attention = false }) {
  return {
    patientId,
    deviceId,
    entryType: 'geofence',
    timestamp,
    payload: { lat, lng, inside_safe_zone: insideSafeZone },
    requiresAttention: attention,
    agentDecision: attention ? 'alert_family' : 'log_only',
  };
}

async function clearExisting() {
  await prisma.quizAttempt.deleteMany({});
  await prisma.quizQuestion.deleteMany({});
  await prisma.logEntryFace.deleteMany({});
  await prisma.logEntry.deleteMany({});
  await prisma.enrolledFace.deleteMany({});
  await prisma.geofenceZone.deleteMany({});
  await prisma.device.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.patient.deleteMany({});
}

async function main() {
  await clearExisting();

  const patient = await prisma.patient.create({
    data: { name: 'Margaret', dob: new Date('1948-04-12') },
  });

  const passwordHash = await bcrypt.hash('caregiver123', 10);
  const caregiver = await prisma.user.create({
    data: {
      name: 'Demo Caregiver',
      email: 'caregiver@example.com',
      passwordHash,
      role: 'family_caregiver',
      patientId: patient.id,
    },
  });

  const camera = await prisma.device.create({
    data: {
      patientId: patient.id,
      deviceType: 'esp32cam',
      identifier: 'esp32cam-living-room',
      apiKeyHash: await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10),
    },
  });

  const watch = await prisma.device.create({
    data: {
      patientId: patient.id,
      deviceType: 'watch',
      identifier: 'watch-margaret',
      apiKeyHash: await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10),
    },
  });

  await prisma.geofenceZone.createMany({
    data: [
      {
        patientId: patient.id,
        name: 'Home',
        centerLat: HOME.lat,
        centerLng: HOME.lng,
        radiusMeters: 120,
        createdBy: caregiver.id,
      },
      {
        patientId: patient.id,
        name: 'The park',
        centerLat: PARK.lat,
        centerLng: PARK.lng,
        radiusMeters: 200,
        createdBy: caregiver.id,
      },
      {
        patientId: patient.id,
        name: 'Corner shop',
        centerLat: SHOP.lat,
        centerLng: SHOP.lng,
        radiusMeters: 80,
        createdBy: caregiver.id,
      },
    ],
  });

  const faces = await prisma.$transaction([
    prisma.enrolledFace.create({
      data: { patientId: patient.id, name: 'Sarah (daughter)', referenceEmbedding: fakeEmbedding(1) },
    }),
    prisma.enrolledFace.create({
      data: { patientId: patient.id, name: 'Raj (son)', referenceEmbedding: fakeEmbedding(2) },
    }),
    prisma.enrolledFace.create({
      data: { patientId: patient.id, name: 'Dr. Menon', referenceEmbedding: fakeEmbedding(3) },
    }),
  ]);

  const entries = [];

  // ---- Two days ago: a light scattering, including one older flagged-and-acknowledged entry ----
  {
    const d = 2;
    const p1 = jitter(HOME, 1);
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 7, 40), {
        activity: 'making breakfast',
        objects: ['kettle', 'toast'],
        personState: 'standing, calm',
      })
    );
    entries.push(
      geofence(patient.id, watch.id, daysAgoAt(d, 8, 10), { lat: p1.lat, lng: p1.lng, insideSafeZone: true })
    );
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 12, 30), {
        activity: 'having lunch at the table',
        objects: ['plate', 'cup'],
        personState: 'seated, calm',
      })
    );
    // An older incident: briefly couldn't find the room, flagged, but acknowledged same day.
    const flagged = frame(patient.id, camera.id, daysAgoAt(d, 15, 5), {
      activity: 'standing still in the hallway, appears disoriented',
      objects: ['hallway'],
      personState: 'standing, hesitant',
      confidence: 0.72,
      attention: true,
    });
    flagged.acknowledgedAt = daysAgoAt(d, 15, 40);
    entries.push(flagged);
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 19, 0), {
        activity: 'watching television',
        objects: ['television', 'sofa'],
        personState: 'seated, relaxed',
      })
    );
  }

  // ---- Yesterday: another light scattering, all unremarkable ----
  {
    const d = 1;
    const p1 = jitter(HOME, 4);
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 7, 55), {
        activity: 'making breakfast',
        objects: ['pan', 'eggs'],
        personState: 'standing, calm',
      })
    );
    entries.push(
      geofence(patient.id, watch.id, daysAgoAt(d, 11, 20), { lat: p1.lat, lng: p1.lng, insideSafeZone: true })
    );
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 11, 45), {
        activity: 'sitting in the living room',
        objects: ['armchair', 'book'],
        personState: 'seated, calm',
      })
    );
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 16, 30), {
        activity: 'having a cup of tea',
        objects: ['teapot', 'cup'],
        personState: 'seated, calm',
      })
    );
    entries.push(
      frame(patient.id, camera.id, daysAgoAt(d, 20, 15), {
        activity: 'watching television',
        objects: ['television'],
        personState: 'seated, relaxed',
      })
    );
  }

  // ---- Today: the full episode arc, ending ~15 minutes ago ----
  // Timestamps are spaced evenly across `spanMinutes`, counting back from now, rather than
  // pinned to clock hours -- that way the arc always lands strictly between midnight and now
  // (never in the future) and always ends 15 minutes ago, however late or early it's run.
  // When little time has elapsed since midnight, the whole arc simply compresses to fit.
  const now = new Date();
  const elapsedMinutesToday = now.getHours() * 60 + now.getMinutes();
  const spanMinutes = Math.max(30, Math.min(600, elapsedMinutesToday - 20));

  const b1 = jitter(HOME, 10);
  const w1 = jitter(HOME, 20, 40);
  const midPoint = { lat: (HOME.lat + PARK.lat) / 2, lng: (HOME.lng + PARK.lng) / 2 };
  const p1 = jitter(PARK, 22);
  const p2 = jitter(PARK, 23, 30);
  const a1 = jitter(AWAY, 30, 20);
  const a2 = jitter(AWAY, 31, 25);
  const r1 = jitter(midPoint, 33, 30);
  const r2 = jitter(HOME, 34);

  // Oldest first; timestamps get assigned below, evenly spaced from `spanMinutes` ago down to
  // exactly 15 minutes ago. Each activity below runs for several consecutive frames (real people
  // stay on one activity for a while) rather than flipping every entry, so the dashboard's
  // episode view reads as a handful of real stretches of the day instead of a stutter of
  // single-entry episodes.
  const todayBuilders = [
    // Morning: making breakfast, then eating it
    () => frame(patient.id, camera.id, null, { activity: 'making breakfast', objects: ['kettle', 'toast', 'jam'], personState: 'standing, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'making breakfast', objects: ['stove', 'pan'], personState: 'standing, humming to herself' }),
    () => frame(patient.id, camera.id, null, { activity: 'making breakfast', objects: ['eggs', 'spatula'], personState: 'standing, calm', confidence: 0.87 }),
    () => geofence(patient.id, watch.id, null, { lat: b1.lat, lng: b1.lng, insideSafeZone: true }),
    () => frame(patient.id, camera.id, null, { activity: 'having breakfast at the table', objects: ['plate', 'cup', 'toast'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'having breakfast at the table', objects: ['cup', 'toast crumbs'], personState: 'seated, relaxed' }),
    () => frame(patient.id, camera.id, null, { activity: 'having breakfast at the table', objects: ['plate', 'newspaper'], personState: 'seated, calm' }),
    // Long quiet stretch: sitting in the living room
    () => frame(patient.id, camera.id, null, { activity: 'sitting in the living room', objects: ['armchair', 'newspaper'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'sitting in the living room', objects: ['armchair', 'radio'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'sitting in the living room', objects: ['armchair'], personState: 'seated, relaxed' }),
    () => frame(patient.id, camera.id, null, { activity: 'sitting in the living room', objects: ['armchair', 'book'], personState: 'seated, calm', confidence: 0.86 }),
    // Late morning: a walk to the park and back through it
    () => geofence(patient.id, watch.id, null, { lat: w1.lat, lng: w1.lng, insideSafeZone: true }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['footpath', 'trees'], personState: 'walking, steady', confidence: 0.85 }),
    () => geofence(patient.id, watch.id, null, { lat: p1.lat, lng: p1.lng, insideSafeZone: true }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['park path', 'birds'], personState: 'walking, unhurried', confidence: 0.84 }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['bench', 'trees'], personState: 'walking, pausing to rest', confidence: 0.86 }),
    () => geofence(patient.id, watch.id, null, { lat: p2.lat, lng: p2.lng, insideSafeZone: true }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['park gate', 'trees'], personState: 'walking, steady', confidence: 0.82 }),
    // ---- THE one genuine incident: wandered outside every zone ----
    () => geofence(patient.id, watch.id, null, { lat: a1.lat, lng: a1.lng, insideSafeZone: false, attention: true }),
    () => frame(patient.id, camera.id, null, { activity: 'not visible on any camera, last known location outside all safe zones', objects: [], personState: 'unknown', confidence: 0.4, attention: true }),
    () => geofence(patient.id, watch.id, null, { lat: a2.lat, lng: a2.lng, insideSafeZone: false, attention: true }),
    // Returning home
    () => geofence(patient.id, watch.id, null, { lat: r1.lat, lng: r1.lng, insideSafeZone: false }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['gate', 'footpath'], personState: 'walking, hurried', confidence: 0.8 }),
    () => frame(patient.id, camera.id, null, { activity: 'walking outdoors', objects: ['driveway', 'gate'], personState: 'walking, relieved', confidence: 0.81 }),
    () => geofence(patient.id, watch.id, null, { lat: r2.lat, lng: r2.lng, insideSafeZone: true }),
    () => frame(patient.id, camera.id, null, { activity: 'sitting in the living room', objects: ['armchair'], personState: 'seated, relaxed, out of breath' }),
    () => ({
      patientId: patient.id,
      deviceId: watch.id,
      entryType: 'heartrate',
      timestamp: null,
      payload: { scenario: 'normal', heart_rate: 78, motion_pattern: 'resting' },
      requiresAttention: false,
      agentDecision: 'log_only',
    }),
    // Afternoon: a long stretch of tea, then a long stretch of television
    () => frame(patient.id, camera.id, null, { activity: 'having a cup of tea', objects: ['teapot', 'cup', 'saucer'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'having a cup of tea', objects: ['cup', 'biscuit'], personState: 'seated, relaxed' }),
    () => frame(patient.id, camera.id, null, { activity: 'having a cup of tea', objects: ['teapot'], personState: 'seated, calm', confidence: 0.88 }),
    () => frame(patient.id, camera.id, null, { activity: 'having a cup of tea', objects: ['cup', 'saucer'], personState: 'seated, content' }),
    () => frame(patient.id, camera.id, null, { activity: 'watching television', objects: ['television', 'sofa'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'watching television', objects: ['television', 'remote'], personState: 'seated, relaxed' }),
    () => frame(patient.id, camera.id, null, { activity: 'watching television', objects: ['television'], personState: 'seated, relaxed', confidence: 0.89 }),
    () => frame(patient.id, camera.id, null, { activity: 'watching television', objects: ['television', 'blanket'], personState: 'seated, cozy' }),
    () => frame(patient.id, camera.id, null, { activity: 'watching television', objects: ['television', 'sofa'], personState: 'seated, drowsy' }),
    // Most recent entries: ends ~15 minutes ago, non-stale
    () => frame(patient.id, camera.id, null, { activity: 'listening to the radio', objects: ['radio', 'armchair'], personState: 'seated, calm' }),
    () => frame(patient.id, camera.id, null, { activity: 'listening to the radio', objects: ['radio'], personState: 'seated, relaxed' }),
    () => frame(patient.id, camera.id, null, { activity: 'listening to the radio', objects: ['radio', 'cup of tea'], personState: 'seated, calm', confidence: 0.9 }),
  ];

  const n = todayBuilders.length;
  todayBuilders.forEach((build, i) => {
    const fractionAgo = n === 1 ? 0 : (n - 1 - i) / (n - 1); // 1 = oldest, 0 = most recent
    const minsAgo = Math.round(15 + fractionAgo * (spanMinutes - 15));
    const entry = build();
    entry.timestamp = minutesAgo(minsAgo);
    entries.push(entry);
  });

  const createdEntries = [];
  for (const e of entries) {
    const created = await prisma.logEntry.create({ data: e });
    createdEntries.push(created);
  }

  // Tag the "not visible on any camera" incident frame with the daughter, since she's the one
  // who gets alerted — link an enrolled face to at least one entry for realism.
  const incidentFrame = createdEntries.find((e) => e.payload.activity && e.payload.activity.startsWith('not visible'));
  if (incidentFrame) {
    await prisma.logEntryFace.create({
      data: { logEntryId: incidentFrame.id, enrolledFaceId: faces[0].id },
    }).catch(() => {}); // face isn't actually in that frame; skip if it doesn't make sense
  }

  // ---- Quiz: grounded in today's actual entries ----
  const breakfastEntry = createdEntries.find((e) => e.payload.activity === 'having breakfast at the table')
    || createdEntries.find((e) => e.payload.activity === 'making breakfast');
  const teaEntry = [...createdEntries].reverse().find((e) => e.payload.activity === 'having a cup of tea');
  const parkEntry = createdEntries.find(
    (e) => e.payload.activity === 'walking outdoors' && e.payload.objects_of_note.includes('bench')
  );

  const quizData = [
    {
      question: 'What did you have this morning?',
      correctAnswer: 'Breakfast — toast and tea',
      sourceLogEntryId: breakfastEntry ? breakfastEntry.id : null,
      attempt: { answered: 'Breakfast', correct: true },
    },
    {
      question: 'Where did you go for a walk today?',
      correctAnswer: 'The park',
      sourceLogEntryId: parkEntry ? parkEntry.id : null,
      attempt: { answered: 'The corner shop', correct: false },
    },
    {
      question: 'What did you drink this afternoon?',
      correctAnswer: 'A cup of tea',
      sourceLogEntryId: teaEntry ? teaEntry.id : null,
      attempt: null,
    },
  ];

  for (const q of quizData) {
    const question = await prisma.quizQuestion.create({
      data: {
        patientId: patient.id,
        date: new Date(),
        question: q.question,
        correctAnswer: q.correctAnswer,
        sourceLogEntryId: q.sourceLogEntryId,
      },
    });
    if (q.attempt) {
      await prisma.quizAttempt.create({
        data: {
          quizQuestionId: question.id,
          answered: q.attempt.answered,
          correct: q.attempt.correct,
        },
      });
    }
  }

  console.log('Seeded patient:', patient.id, `(${patient.name})`);
  console.log('Seeded caregiver login: caregiver@example.com / caregiver123 (user id', caregiver.id, ')');
  console.log('Log entries created:', createdEntries.length);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
