const prisma = require('../config/prisma');
const { gatherContext, buildPrompt, parseAnswer } = require('../services/assistantService');
const { enqueueAgent, waitFor } = require('../services/jobQueue');
const { TYPES } = require('../services/commandTypes');
const fallCheck = require('../services/fallCheck');
const voice = require('../services/voiceService');
const story = require('../services/storyService');
const rules = require('../services/ruleEngine');
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
      payload: voice.wantsVoice(type) ? { ...payload, voice_pending: true } : payload,
      createdBy: req.user.sub,
      senderName: (user?.name || 'Family').split(' ')[0],
      expiresAt: new Date(Date.now() + COMMAND_TTL_MIN * 60000),
    },
  });
  if (voice.wantsVoice(type)) voice.prepareCommand(cmd); // natural voice, ready in a few seconds
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
  const pending = (await prisma.deviceCommand.findMany({ where: { patientId, status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 8 }))
    .filter((c) => !c.payload?.voice_pending || c.createdAt.getTime() < Date.now() - voice.holdFor(c.type) - 2000)
    .slice(0, 5);
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
  if (cmd.type === 'ask' && cmd.payload?.fall_check && ok) await fallCheck.answered(cmd, String(req.body?.reply || '')).catch((e) => console.error('[fall]', e.message));
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

// ---- "tell me when…" rules (#8) -----------------------------------------------------------------

// GET /api/patients/:id/rules
async function listRules(req, res) {
  if (!ownPatient(req, res)) return;
  const list = await prisma.watchRule.findMany({ where: { patientId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 30 });
  res.json(list.map((r) => ({ id: r.id, kind: r.kind, params: r.params, label: r.label, repeat: r.repeat, active: r.active, fired_count: r.firedCount, last_fired_at: r.lastFiredAt, created_by: r.creatorName, created_at: r.createdAt })));
}

// POST /api/patients/:id/rules  { kind, params, repeat }
async function createRule(req, res) {
  if (!ownPatient(req, res)) return;
  const [patient, user] = await Promise.all([
    prisma.patient.findUnique({ where: { id: req.params.id } }),
    prisma.user.findUnique({ where: { id: req.user.sub } }),
  ]);
  const clean = rules.cleanRule(req.body || {}, (patient?.name || 'them').split(' ')[0]);
  if (!clean) return res.status(400).json({ error: 'That rule is not one I can watch for yet' });
  const r = await prisma.watchRule.create({
    data: { patientId: req.params.id, createdBy: req.user.sub, creatorName: (user?.name || 'Family').split(' ')[0], ...clean },
  });
  res.status(201).json({ id: r.id, label: r.label, kind: r.kind, params: r.params, repeat: r.repeat, active: r.active });
}

// DELETE /api/patients/:id/rules/:rid
async function deleteRule(req, res) {
  if (!ownPatient(req, res)) return;
  await prisma.watchRule.deleteMany({ where: { id: req.params.rid, patientId: req.params.id } });
  res.status(204).send();
}

// ---- bedtime story (#18) ------------------------------------------------------------------------

// POST /api/patients/:id/story — write today's story now and send it to the phone
async function sendStoryNow(req, res) {
  if (!ownPatient(req, res)) return;
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  try {
    res.json(await story.sendStory(req.params.id, { senderName: (user?.name || 'Family').split(' ')[0], createdBy: req.user.sub }));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}

// GET/PUT /api/patients/:id/story-settings  { at: "HH:MM" | null }
async function storySettings(req, res) {
  if (!ownPatient(req, res)) return;
  if (req.method === 'PUT') {
    const at = req.body?.at;
    if (at !== null && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(at || ''))) return res.status(400).json({ error: 'at must be HH:MM or null' });
    await prisma.patient.update({ where: { id: req.params.id }, data: { bedtimeStoryAt: at } });
  }
  const p = await prisma.patient.findUnique({ where: { id: req.params.id }, select: { bedtimeStoryAt: true } });
  res.json({ at: p?.bedtimeStoryAt || null });
}

module.exports = { ask, createCommand, listCommands, pullCommands, ackCommand, uploadVoiceNote, listRules, createRule, deleteRule, sendStoryNow, storySettings };
