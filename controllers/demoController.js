const prisma = require('../config/prisma');
const demo = require('../services/demoService');
const journal = require('../services/journalService');
const { enqueueFrame } = require('../services/jobQueue');
const { recordPing } = require('./geofenceController');
const history = require('../services/demoHistory');
const sms = require('../services/smsService');

const SCENES = ['eating', 'tv', 'resting', 'leaving', 'fall', 'empty'];

function guard(req, res) {
  if (!demo.isDemoMode()) {
    res.status(403).json({ error: 'Demo mode is off (set DEMO_MODE=1 on the server)' });
    return false;
  }
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

// GET /api/demo/:id — what the demo kit has to work with
async function state(req, res) {
  if (!demo.isDemoMode()) return res.json({ demo_mode: false });
  if (!guard(req, res)) return;
  const [scenes, zones, pendingAsk, latestPhoto, historyCount, contacts, texts] = await Promise.all([
    demo.listScenes(req.params.id),
    prisma.geofenceZone.findMany({ where: { patientId: req.params.id }, select: { name: true } }),
    prisma.deviceCommand.findFirst({ where: { patientId: req.params.id, type: 'ask', status: { in: ['pending', 'delivered'] } }, orderBy: { createdAt: 'desc' } }),
    prisma.logEntry.findFirst({ where: { patientId: req.params.id, entryType: 'frame', imagePublicId: { not: null } }, orderBy: { timestamp: 'desc' } }),
    history.hasHistory(req.params.id),
    prisma.emergencyContact.count({ where: { patientId: req.params.id } }),
    prisma.deviceCommand.findMany({ where: { patientId: req.params.id, type: 'sms' }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);
  res.json({
    demo_mode: true,
    scene_names: SCENES,
    scenes,
    has_home: zones.some((z) => /home/i.test(z.name)),
    walk_active: demo.isWalkActive(req.params.id),
    history_entries: historyCount,
    sms_contacts: contacts,
    sms_recent: texts.map((c) => ({ id: c.id, reason: c.payload?.reason, text: c.payload?.text, to: (c.payload?.to || []).length, status: c.status, error: c.error || null, at: c.createdAt })),
    pending_ask: pendingAsk ? { id: pendingAsk.id, question: pendingAsk.payload.question, quick: pendingAsk.payload.quick } : null,
    latest_photo: latestPhoto ? { log_entry_id: latestPhoto.id, image_public_id: latestPhoto.imagePublicId, activity: latestPhoto.payload?.activity, at: latestPhoto.timestamp } : null,
  });
}

// POST /api/demo/:id/scenes/:name/save  { log_entry_id? } — keep the latest (or a chosen) photo as a scene
async function saveScene(req, res) {
  if (!guard(req, res)) return;
  if (!SCENES.includes(req.params.name)) return res.status(400).json({ error: 'Unknown scene' });
  const entry = req.body?.log_entry_id
    ? await prisma.logEntry.findUnique({ where: { id: req.body.log_entry_id } })
    : await prisma.logEntry.findFirst({ where: { patientId: req.params.id, entryType: 'frame', imagePublicId: { not: null } }, orderBy: { timestamp: 'desc' } });
  if (!entry?.imagePublicId || entry.patientId !== req.params.id) return res.status(404).json({ error: 'No camera photo to save yet' });
  res.json(await demo.saveScene(req.params.id, req.params.name, entry));
}

// POST /api/demo/:id/scenes/:name/play — replay a saved scene through the real AI pipeline
async function playScene(req, res) {
  if (!guard(req, res)) return;
  const scene = (await demo.listScenes(req.params.id))[req.params.name];
  if (!scene) return res.status(404).json({ error: 'That scene has not been saved yet' });
  const image = await demo.sceneImageBase64(scene.image_public_id);
  const camera = await demo.demoDevice(req.params.id, 'camera');
  const job = await enqueueFrame({ device: camera, image, capturedAt: new Date() });
  res.status(202).json({ job_id: job.id });
}

// POST /api/demo/:id/walk  { direction: 'away' | 'home' | 'stop' }
async function walk(req, res) {
  if (!guard(req, res)) return;
  const direction = req.body?.direction;
  if (direction === 'stop') {
    demo.stopWalk(req.params.id);
    return res.json({ stopped: true });
  }
  if (!['away', 'home'].includes(direction)) return res.status(400).json({ error: 'direction must be away, home or stop' });
  try {
    res.json(await demo.startWalk(req.params.id, direction, recordPing));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// POST /api/demo/:id/answer  { reply } — answer the latest question as Margaret (no phone needed)
async function answer(req, res) {
  if (!guard(req, res)) return;
  const via = req.body?.via === 'watch' ? 'watch' : 'phone';
  const cmd = await prisma.deviceCommand.findFirst({ where: { patientId: req.params.id, type: 'ask', target: via, status: { in: ['pending', 'delivered'] } }, orderBy: { createdAt: 'desc' } });
  if (!cmd) return res.status(404).json({ error: 'No question is waiting for an answer' });
  const reply = String(req.body?.reply || '').trim().slice(0, 300) || 'Yes';
  const answeredCmd = { ...cmd, payload: { ...cmd.payload, via } };
  if (cmd.payload?.fall_check) await require('../services/fallCheck').answered(answeredCmd, reply).catch(() => {});
  await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: { status: 'done', doneAt: new Date(), deliveredAt: cmd.deliveredAt || new Date(), payload: { ...cmd.payload, reply, via, replied_at: new Date().toISOString() } },
  });
  res.json({ answered: cmd.payload.question, reply });
}

// POST /api/demo/:id/reset
async function reset(req, res) {
  if (!guard(req, res)) return;
  const r = await demo.reset(req.params.id);
  await journal.writeDay(req.params.id).catch(() => {});
  res.json(r);
}

// POST /api/demo/:id/tick — run the scheduler now (rules, fall checks, bedtime) instead of waiting 30 s
async function tick(req, res) {
  if (!guard(req, res)) return;
  res.json(await require('../services/scheduler').tick());
}

// POST /api/demo/:id/fall — a fall seen by the camera, without staging one (no photo)
async function fall(req, res) {
  if (!guard(req, res)) return;
  const camera = await demo.demoDevice(req.params.id, 'camera');
  const entry = await prisma.logEntry.create({
    data: {
      patientId: req.params.id, deviceId: camera.id, entryType: 'frame', timestamp: new Date(), requiresAttention: true,
      payload: { activity_key: 'fallen', activity: 'on the floor, may have fallen', person_state: 'lying on the floor', objects_of_note: [], confidence: 0.8, requires_attention: true, analysed_by: 'demo', demo: true },
    },
  });
  require('../services/decisionService').decideFor(entry.id);
  const cmd = await require('../services/fallCheck').start(req.params.id, { logEntryId: entry.id, reason: 'The camera saw a possible fall (simulated)' });
  await journal.writeDay(req.params.id).catch(() => {});
  res.json({ log_entry_id: entry.id, fall_check: cmd ? cmd.id : 'already running' });
}

// POST /api/demo/:id/history { days } — two weeks of plausible past days (for the report, summaries, replay)
// DELETE /api/demo/:id/history
async function historyRoute(req, res) {
  if (!guard(req, res)) return;
  if (req.method === 'DELETE') return res.json(await history.clearHistory(req.params.id));
  res.json(await history.seedHistory(req.params.id, req.body?.days || 14));
}

// POST /api/demo/:id/fill — two weeks of past days in the log plus a week of watch readings.
async function fill(req, res) {
  if (!guard(req, res)) return;
  const log = await history.seedHistory(req.params.id, 14);
  const watch = await require('../services/watchService').seedHistory(req.params.id, 7);
  res.json({ ...log, watch_readings: watch.readings });
}

// POST /api/demo/:id/clear-log — an empty log (every day), so frames from the real camera stand alone.
// Watch readings are kept: they live on the Watch tab, not in the log.
async function clearLog(req, res) {
  if (!guard(req, res)) return;
  const pid = req.params.id;
  const ids = (await prisma.logEntry.findMany({ where: { patientId: pid, entryType: { not: 'heartrate' } }, select: { id: true } })).map((e) => e.id);
  const questions = await prisma.quizQuestion.findMany({ where: { sourceLogEntryId: { in: ids } }, select: { id: true } });
  await prisma.quizAttempt.deleteMany({ where: { quizQuestionId: { in: questions.map((q) => q.id) } } });
  await prisma.quizQuestion.deleteMany({ where: { id: { in: questions.map((q) => q.id) } } });
  await prisma.logEntryFace.deleteMany({ where: { logEntryId: { in: ids } } });
  await prisma.familyEvent.deleteMany({ where: { patientId: pid, OR: [{ refId: { in: ids } }, { kind: { in: ['visitor', 'fall_check', 'fall_ok', 'fall_escalated', 'rule'] } }] } });
  await prisma.aiJob.deleteMany({ where: { patientId: pid } });
  const r = await prisma.logEntry.deleteMany({ where: { id: { in: ids } } });
  for (let ago = 14; ago >= 0; ago--) await journal.writeDay(pid, new Date(Date.now() - ago * 864e5)).catch(() => {});
  res.json({ removed: r.count });
}

// POST /api/demo/:id/sms  { reason } — text the emergency contacts now, as that alert would
const DEMO_TEXTS = {
  left_safe_area: (n) => `${n} has left the safe places.`,
  heart_spike: (n) => `${n}'s watch sent an emergency: heart rate spike (138 bpm), then still. Please call.`,
  sos: (n) => `${n} pressed Hold for help on the watch. Please call now.`,
  test: (n) => `This is a test text about ${n}. Alerts will arrive like this.`,
};
async function smsRoute(req, res) {
  if (!guard(req, res)) return;
  const reason = req.body?.reason || 'test';
  if (!DEMO_TEXTS[reason]) return res.status(400).json({ error: 'Unknown text' });
  const p = await prisma.patient.findUnique({ where: { id: req.params.id }, select: { name: true } });
  const r = await sms.alert(req.params.id, reason, DEMO_TEXTS[reason](p.name.split(' ')[0]), { force: true });
  if (!r.queued) return res.status(400).json({ error: 'Add an emergency contact first (Settings → Emergency tag).' });
  res.json(r);
}

module.exports = { smsRoute, fill, clearLog, state, saveScene, playScene, walk, answer, reset, tick, fall, historyRoute };
