const prisma = require('../config/prisma');
const { gatherContext, buildPrompt, parseAnswer } = require('../services/assistantService');
const { enqueueAgent, waitFor } = require('../services/jobQueue');
const { TYPES } = require('../services/commandTypes');
const cloudinary = require('../config/cloudinary');

const COMMAND_TTL_MIN = 10; // an action the phone hasn't picked up in 10 min is stale

function ownPatient(req, res) {
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

// POST /api/patients/:id/assistant  { message, history: [{role:'user'|'assistant', text}] }
async function ask(req, res) {
  if (!ownPatient(req, res)) return;
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'message is required' });

  const [patient, user] = await Promise.all([
    prisma.patient.findUnique({ where: { id: req.params.id } }),
    prisma.user.findUnique({ where: { id: req.user.sub } }),
  ]);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const started = Date.now();
  const ctx = await gatherContext(patient);
  const prompt = buildPrompt({
    firstName: patient.name.split(' ')[0],
    caregiverName: (user?.name || 'Family').split(' ')[0],
    context: ctx.text,
    history: Array.isArray(req.body?.history) ? req.body.history : [],
    message,
  });
  const job = await enqueueAgent({ patientId: patient.id, prompt });
  const done = await waitFor(job.id, 60000);
  if (!done || done.status !== 'done') {
    return res.status(503).json({ error: 'The assistant could not answer just now. Try again in a moment.' });
  }
  const { reply, actions } = parseAnswer(done.result.text);
  res.json({ reply, actions, provider: done.result.provider, sources: ctx.sources, ms: Date.now() - started });
}

// POST /api/patients/:id/commands  { type, ...fields }  — the family confirmed an action.
async function createCommand(req, res) {
  if (!ownPatient(req, res)) return;
  const type = String(req.body?.type || '');
  if (!TYPES[type]) return res.status(400).json({ error: `Unknown action "${type}"` });
  let payload;
  try {
    payload = TYPES[type].clean(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const cmd = await prisma.deviceCommand.create({
    data: {
      patientId: req.params.id,
      type,
      payload,
      createdBy: req.user.sub,
      senderName: (user?.name || 'Family').split(' ')[0],
      expiresAt: new Date(Date.now() + COMMAND_TTL_MIN * 60000),
    },
  });
  res.status(201).json(publicCommand(cmd));
}

// GET /api/patients/:id/commands — recent ones with their delivery status.
async function listCommands(req, res) {
  if (!ownPatient(req, res)) return;
  await expireOld(req.params.id);
  const cmds = await prisma.deviceCommand.findMany({ where: { patientId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  res.json(cmds.map(publicCommand));
}

// GET /api/devices/commands?device_id=…  (device key) — the phone picks up what's waiting.
async function pullCommands(req, res) {
  const patientId = req.device.patientId;
  await expireOld(patientId);
  const pending = await prisma.deviceCommand.findMany({ where: { patientId, status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 5 });
  if (pending.length) {
    await prisma.deviceCommand.updateMany({ where: { id: { in: pending.map((c) => c.id) }, status: 'pending' }, data: { status: 'delivered', deliveredAt: new Date() } });
  }
  res.json(pending.map((c) => ({ id: c.id, type: c.type, from: c.senderName, created_at: c.createdAt, ...c.payload })));
}

// POST /api/devices/commands/:cid/ack  { device_id, ok, error?, reply? }
//   ask:     sent when the patient answers (reply = what they said / tapped)
//   capture: sent once the photo is uploaded; it becomes "done" when the photo has been described
//   others:  sent once carried out
async function ackCommand(req, res) {
  const cmd = await prisma.deviceCommand.findUnique({ where: { id: req.params.cid } });
  if (!cmd || cmd.patientId !== req.device.patientId) return res.status(404).json({ error: 'Unknown command' });
  const ok = req.body?.ok !== false;
  let data;
  if (!ok) data = { status: 'failed', error: String(req.body?.error || '').slice(0, 200), doneAt: new Date() };
  else if (cmd.type === 'ask') data = { status: 'done', doneAt: new Date(), payload: { ...cmd.payload, reply: String(req.body?.reply || '').trim().slice(0, 300), replied_at: new Date().toISOString() } };
  else if (cmd.type === 'capture') data = { payload: { ...cmd.payload, uploaded: true } };
  else data = { status: 'done', doneAt: new Date() };
  await prisma.deviceCommand.update({ where: { id: cmd.id }, data });
  res.json({ ok: true });
}

// POST /api/patients/:id/voice-notes  { audio: base64, mime }  → { url (mp3), seconds }
// Recorded in the browser; stored on Cloudinary (as a "video" resource, which covers audio) and
// handed to the phone as an mp3 link, which every Android version plays.
async function uploadVoiceNote(req, res) {
  if (!ownPatient(req, res)) return;
  const { audio, mime = 'audio/webm' } = req.body || {};
  if (!audio || typeof audio !== 'string') return res.status(400).json({ error: 'audio is required' });
  if (audio.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Voice note is too long (keep it under 2 minutes)' });
  // Browsers report e.g. "audio/webm;codecs=opus"; the parameter breaks the data URI for Cloudinary.
  const type = String(mime).split(';')[0].trim() || 'audio/webm';
  const r = await cloudinary.uploader.upload(`data:${type};base64,${audio}`, { resource_type: 'video', folder: 'assist/voice' });
  const url = cloudinary.url(r.public_id, { resource_type: 'video', format: 'mp3', secure: true });
  res.status(201).json({ url, seconds: Math.round(r.duration || 0) });
}

async function expireOld(patientId) {
  await prisma.deviceCommand.updateMany({ where: { patientId, status: 'pending', expiresAt: { lt: new Date() } }, data: { status: 'expired' } });
}

function publicCommand(c) {
  return {
    id: c.id, type: c.type, ...c.payload, status: c.status, from: c.senderName,
    created_at: c.createdAt, delivered_at: c.deliveredAt, done_at: c.doneAt, error: c.error,
  };
}

module.exports = { ask, createCommand, listCommands, pullCommands, ackCommand, uploadVoiceNote };
