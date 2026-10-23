const prisma = require('../config/prisma');
const fallCheck = require('./fallCheck');

// The watch (vitals are scripted scenarios, not live sensors — spec §8.5). Readings live in
// log_entries (entry_type heartrate) but are kept out of the log: the Watch tab reads them here.

const SCENARIOS = ['normal', 'confusion', 'emergency', 'sos'];
const UNSETTLED_EVERY_MS = 30 * 60000;
const HISTORY_DEVICE = 'demo:watch-history';

const firstName = async (patientId) =>
  ((await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true } }))?.name || 'They').split(' ')[0];

/** Store one reading and run what it sets off (fall check, "seems unsettled"). Used by the watch and the demo. */
async function recordReading(device, { scenario, heart_rate, motion_pattern, timestamp, battery }) {
  // Hold for help arrives as an emergency with motion "sos" (or as scenario "sos" from the demo).
  const sos = scenario === 'sos' || motion_pattern === 'sos';
  const stored = sos ? 'emergency' : scenario;
  const entry = await prisma.logEntry.create({
    data: {
      patientId: device.patientId,
      deviceId: device.id,
      entryType: 'heartrate',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      payload: { scenario: stored, heart_rate, motion_pattern: sos ? 'sos' : motion_pattern, source: 'watch', ...(Number.isFinite(battery) && { battery }) },
      requiresAttention: stored === 'emergency',
    },
  });

  const pid = device.patientId;
  if (sos) {
    // She already asked for help: no "are you okay?", straight to the family and a ringing phone.
    const first = await firstName(pid);
    await prisma.$transaction([
      prisma.familyEvent.create({ data: { patientId: pid, kind: 'sos', severity: 'act', title: `⚠ ${first} pressed Hold for help on the watch`, body: 'The watch asked for help. Their phone is ringing. Call now.', refId: entry.id } }),
      prisma.deviceCommand.create({ data: { patientId: pid, type: 'ring', payload: {}, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) } }),
    ]);
  } else if (stored === 'emergency') {
    await fallCheck.start(pid, { logEntryId: entry.id, reason: 'The watch sent an emergency (heart rate spike, then still)' }).catch(() => {});
  } else if (stored === 'confusion') {
    const recent = await prisma.familyEvent.findFirst({ where: { patientId: pid, kind: 'watch_unsettled', createdAt: { gte: new Date(Date.now() - UNSETTLED_EVERY_MS) } } });
    if (!recent) {
      const first = await firstName(pid);
      await prisma.familyEvent.create({
        data: { patientId: pid, kind: 'watch_unsettled', severity: 'watch', title: `${first} seems unsettled`, body: `The watch shows a raised heart rate (about ${heart_rate} bpm)${motion_pattern === 'pacing' ? ' and pacing' : ''}.`, refId: entry.id },
      });
    }
  }
  return entry;
}

// ---- the Watch tab ------------------------------------------------------------------------------

const RANGES = { today: null, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

function rangeStart(range) {
  if (RANGES[range]) return new Date(Date.now() - RANGES[range]);
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function vitals(patientId, range = 'today') {
  if (!(range in RANGES)) range = 'today';
  const from = rangeStart(range);
  const [rows, devices, events, commands] = await Promise.all([
    prisma.logEntry.findMany({ where: { patientId, entryType: 'heartrate', timestamp: { gte: from } }, orderBy: { timestamp: 'asc' }, select: { id: true, timestamp: true, payload: true, requiresAttention: true } }),
    prisma.device.findMany({ where: { patientId, deviceType: 'watch' }, select: { id: true, identifier: true, createdAt: true } }),
    prisma.familyEvent.findMany({ where: { patientId, createdAt: { gte: from }, kind: { in: ['fall_check', 'fall_ok', 'fall_escalated', 'watch_unsettled', 'sos'] } }, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.deviceCommand.findMany({ where: { patientId, target: 'watch', type: { not: 'dismiss' }, createdAt: { gte: from } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  const latestRow = await prisma.logEntry.findFirst({ where: { patientId, entryType: 'heartrate' }, orderBy: { timestamp: 'desc' } });

  const pts = rows.map((r) => ({ t: r.timestamp.getTime(), bpm: Number(r.payload?.heart_rate) || null, scenario: r.payload?.scenario || 'normal', motion: r.payload?.motion_pattern || null })).filter((p) => p.bpm);

  // ≤ 300 points: average per bucket, the bucket keeps its "worst" scenario so bands stay visible.
  const span = Date.now() - from.getTime();
  const bucket = Math.max(60e3, Math.ceil(span / 300 / 60e3) * 60e3);
  const RANK = { normal: 0, confusion: 1, emergency: 2 };
  const buckets = new Map();
  for (const p of pts) {
    const k = Math.floor(p.t / bucket) * bucket;
    const b = buckets.get(k) || { t: k + bucket / 2, sum: 0, n: 0, scenario: 'normal', motion: p.motion };
    b.sum += p.bpm;
    b.n += 1;
    if ((RANK[p.scenario] || 0) >= (RANK[b.scenario] || 0)) { b.scenario = p.scenario; b.motion = p.motion; }
    buckets.set(k, b);
  }
  const series = [...buckets.values()].map((b) => ({ t: new Date(Math.min(b.t, Date.now())).toISOString(), bpm: Math.round(b.sum / b.n), scenario: b.scenario, motion: b.motion }));

  // Runs of a non-normal scenario (gaps under 15 min joined).
  const bands = [];
  for (const p of pts) {
    if (p.scenario === 'normal') continue;
    const last = bands[bands.length - 1];
    if (last && last.scenario === p.scenario && p.t - last.to <= 15 * 60000) last.to = p.t;
    else bands.push({ scenario: p.scenario, from: p.t, to: p.t });
  }

  const calm = pts.filter((p) => p.scenario === 'normal' && (p.motion === 'resting' || !p.motion));
  const max = pts.reduce((m, p) => (!m || p.bpm > m.bpm ? p : m), null);
  // Minutes unsettled: time covered by confusion readings, each counted up to 5 min.
  let unsettledMs = 0;
  pts.forEach((p, i) => {
    if (p.scenario !== 'confusion') return;
    const next = pts[i + 1];
    unsettledMs += Math.min(next ? next.t - p.t : 60e3, 5 * 60e3);
  });
  const emergencies = rows.filter((r) => r.requiresAttention);

  const evs = [
    ...events.map((e) => ({ at: e.createdAt, kind: e.kind === 'watch_unsettled' ? 'unsettled' : e.kind, title: e.title, body: e.body, severity: e.severity })),
    ...commands.map((c) => ({ at: c.createdAt, kind: `cmd_${c.type}`, title: commandTitle(c), status: c.status, reply: c.payload?.reply || null, severity: 'info' })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 30);

  const real = devices.find((d) => !d.identifier.startsWith('demo:'));
  const lastSeen = latestRow?.timestamp || null;
  return {
    range,
    device: {
      paired: devices.length > 0,
      name: real ? 'Galaxy Watch' : devices.length ? 'Demo watch' : null,
      paired_at: (real || devices[0])?.createdAt || null,
      last_seen: lastSeen,
      battery: latestRow?.payload?.battery ?? null,
      simulated: isSimulating(patientId),
    },
    latest: latestRow ? { at: latestRow.timestamp, bpm: latestRow.payload?.heart_rate ?? null, scenario: latestRow.payload?.scenario || 'normal', motion: latestRow.payload?.motion_pattern || null } : null,
    summary: {
      resting_avg: calm.length ? Math.round(calm.reduce((s, p) => s + p.bpm, 0) / calm.length) : null,
      max: max ? { bpm: max.bpm, at: new Date(max.t).toISOString() } : null,
      minutes_unsettled: Math.round(unsettledMs / 60e3),
      emergencies: emergencies.length,
      last_emergency: emergencies.length ? emergencies[emergencies.length - 1].timestamp : null,
      readings: pts.length,
    },
    series,
    // The last 10 minutes as they came in, for the live strip.
    recent: pts.filter((p) => p.t >= Date.now() - 10 * 60e3).slice(-120).map((p) => ({ t: new Date(p.t).toISOString(), bpm: p.bpm, scenario: p.scenario })),
    bands: bands.map((b) => ({ scenario: b.scenario, from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString() })),
    events: evs,
  };
}

function commandTitle(c) {
  const p = c.payload || {};
  switch (c.type) {
    case 'speak': return `Message on the watch: “${p.text}”`;
    case 'ask': return `Asked on the watch: “${p.question}”`;
    case 'calm': return 'Breathing exercise on the watch';
    case 'guide_home': return 'Way home on the watch';
    case 'reminder': return `Reminder on the watch: “${p.text}”`;
    default: return c.type;
  }
}

// ---- demo: a simulated watch, so the tab is demoable without the real one ---------------------

const sims = new Map(); // patientId → { scenario, timer, until, tick }
const SIM_EVERY_MS = 5000;
const SIM_FOR_MS = 45 * 60000;

const jitter = (a, b) => Math.round(a + Math.random() * (b - a));

function simReading(scenario, tick) {
  if (scenario === 'confusion') return { scenario, heart_rate: jitter(104, 118), motion_pattern: 'pacing' };
  if (scenario === 'emergency' || scenario === 'sos') {
    // Spike, then still.
    return tick === 0
      ? { scenario, heart_rate: jitter(128, 136), motion_pattern: scenario === 'sos' ? 'sos' : 'fall_detected' }
      : { scenario: 'emergency', heart_rate: jitter(92, 100), motion_pattern: 'still', followUp: true };
  }
  return { scenario: 'normal', heart_rate: jitter(68, 78), motion_pattern: 'resting' };
}

async function simStep(patientId) {
  const s = sims.get(patientId);
  if (!s) return;
  if (Date.now() > s.until) return stopSim(patientId);
  const device = await require('./demoService').demoDevice(patientId, 'watch');
  const r = simReading(s.scenario, s.tick++);
  if (r.followUp) {
    // After the one emergency event, keep the line moving without re-alerting.
    await prisma.logEntry.create({ data: { patientId, deviceId: device.id, entryType: 'heartrate', payload: { scenario: 'emergency', heart_rate: r.heart_rate, motion_pattern: 'still', source: 'watch', follow_up: true } } });
  } else {
    await recordReading(device, r);
  }
}

async function simulate(patientId, scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error('scenario must be normal, confusion, emergency or sos');
  stopSim(patientId);
  const s = { scenario, tick: 0, until: Date.now() + SIM_FOR_MS };
  sims.set(patientId, s);
  await simStep(patientId);
  s.timer = setInterval(() => simStep(patientId).catch((e) => console.error('[watch sim]', e.message)), SIM_EVERY_MS);
  return { scenario, every_s: SIM_EVERY_MS / 1000, minutes: SIM_FOR_MS / 60000 };
}

function stopSim(patientId) {
  const s = sims.get(patientId);
  if (s) clearInterval(s.timer);
  sims.delete(patientId);
  return { stopped: Boolean(s) };
}

const isSimulating = (patientId) => (sims.get(patientId)?.scenario) || null;

/** With the simulated watch running, "deliver" watch commands like the real one would. */
function simulateDelivery(cmd) {
  if (!isSimulating(cmd.patientId) || cmd.type === 'dismiss') return;
  setTimeout(() => prisma.deviceCommand.update({ where: { id: cmd.id }, data: { status: 'delivered', deliveredAt: new Date() } }).catch(() => {}), 1500);
  if (cmd.payload?.fall_check) return; // answered from the Watch tab, so "no answer" can be shown too
  setTimeout(async () => {
    const reply = cmd.type === 'ask' ? (cmd.payload?.quick?.[0] || 'Yes') : null;
    await prisma.deviceCommand.update({
      where: { id: cmd.id },
      data: { status: 'done', doneAt: new Date(), ...(reply && { payload: { ...cmd.payload, reply, replied_at: new Date().toISOString(), via: 'watch' } }) },
    }).catch(() => {});
    if (reply && cmd.payload?.fall_check) await fallCheck.answered(cmd, reply).catch(() => {});
  }, cmd.type === 'ask' ? 7000 : 4000);
}

/** A week of plausible readings: calm days, two unsettled evenings, one emergency. */
async function seedHistory(patientId, days = 7) {
  await clearHistory(patientId);
  const device = await require('./demoService').demoDevice(patientId, 'watch-history');
  const rows = [];
  const now = Date.now();
  const unsettledDays = [2, 5];
  const emergencyDay = 3;
  for (let t = now - days * 24 * 3600e3; t < now - 15 * 60e3; t += 10 * 60e3) {
    const d = new Date(t);
    const ago = Math.floor((now - t) / (24 * 3600e3));
    const h = d.getHours() + d.getMinutes() / 60;
    let scenario = 'normal';
    let bpm = h < 7 || h >= 22 ? jitter(58, 66) : jitter(68, 80);
    let motion = h < 7 || h >= 22 ? 'resting' : Math.random() < 0.25 ? 'walking' : 'resting';
    if (motion === 'walking') bpm += 10;
    if (unsettledDays.includes(ago) && h >= 18.3 && h < 19.1) { scenario = 'confusion'; bpm = jitter(104, 118); motion = 'pacing'; }
    rows.push({ patientId, deviceId: device.id, entryType: 'heartrate', timestamp: d, requiresAttention: false, payload: { scenario, heart_rate: bpm, motion_pattern: motion, source: 'watch', simulated: true } });
  }
  const em = new Date(now - emergencyDay * 24 * 3600e3);
  em.setHours(10, 42, 0, 0);
  rows.push({ patientId, deviceId: device.id, entryType: 'heartrate', timestamp: em, requiresAttention: true, payload: { scenario: 'emergency', heart_rate: 131, motion_pattern: 'fall_detected', source: 'watch', simulated: true } });
  await prisma.logEntry.createMany({ data: rows });
  return { readings: rows.length, days };
}

async function clearHistory(patientId) {
  const device = await prisma.device.findFirst({ where: { patientId, identifier: HISTORY_DEVICE } });
  if (!device) return { removed: 0 };
  const r = await prisma.logEntry.deleteMany({ where: { deviceId: device.id } });
  return { removed: r.count };
}

module.exports = { SCENARIOS, recordReading, vitals, simulate, stopSim, isSimulating, simulateDelivery, seedHistory, clearHistory, HISTORY_DEVICE };
