const prisma = require('../config/prisma');
const demo = require('../services/demoService');
const journal = require('../services/journalService');
const { enqueueFrame } = require('../services/jobQueue');
const { recordPing } = require('./geofenceController');

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
  const [scenes, zones, pendingAsk, latestPhoto] = await Promise.all([
    demo.listScenes(req.params.id),
    prisma.geofenceZone.findMany({ where: { patientId: req.params.id }, select: { name: true } }),
    prisma.deviceCommand.findFirst({ where: { patientId: req.params.id, type: 'ask', status: { in: ['pending', 'delivered'] } }, orderBy: { createdAt: 'desc' } }),
    prisma.logEntry.findFirst({ where: { patientId: req.params.id, entryType: 'frame', imagePublicId: { not: null } }, orderBy: { timestamp: 'desc' } }),
  ]);
  res.json({
    demo_mode: true,
    scene_names: SCENES,
    scenes,
    has_home: zones.some((z) => /home/i.test(z.name)),
    walk_active: demo.isWalkActive(req.params.id),
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
  const cmd = await prisma.deviceCommand.findFirst({ where: { patientId: req.params.id, type: 'ask', status: { in: ['pending', 'delivered'] } }, orderBy: { createdAt: 'desc' } });
  if (!cmd) return res.status(404).json({ error: 'No question is waiting for an answer' });
  const reply = String(req.body?.reply || '').trim().slice(0, 300) || 'Yes';
  if (cmd.payload?.fall_check) await require('../services/fallCheck').answered(cmd, reply).catch(() => {});
  await prisma.deviceCommand.update({
    where: { id: cmd.id },
    data: { status: 'done', doneAt: new Date(), deliveredAt: cmd.deliveredAt || new Date(), payload: { ...cmd.payload, reply, replied_at: new Date().toISOString() } },
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

module.exports = { state, saveScene, playScene, walk, answer, reset, tick, fall };
