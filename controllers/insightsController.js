const prisma = require('../config/prisma');
const cloudinary = require('../config/cloudinary');
const insights = require('../services/insightsService');
const { enqueueSummary, waitFor } = require('../services/jobQueue');
const voice = require('../services/voiceService');
const { TYPES } = require('../services/commandTypes');

// Batch D: looking back (find an object, the doctor's report) and reminiscence (the family photo album).

function ownPatient(req, res) {
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

// GET /api/patients/:id/find?q=glasses — last sightings of an object on the home camera
async function find(req, res) {
  if (!ownPatient(req, res)) return;
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (!q) return res.status(400).json({ error: 'q is required' });
  res.json(await insights.findObject(req.params.id, q));
}

// GET /api/patients/:id/report?days=7|14|28 — the numbers behind the doctor's report
async function report(req, res) {
  if (!ownPatient(req, res)) return;
  res.json(await insights.buildReport(req.params.id, req.query.days));
}

// GET /api/patients/:id/report/note?days=… — a short written note for the doctor, by a helper.
// Cached in memory until the numbers change.
const noteCache = new Map();
async function reportNote(req, res) {
  if (!ownPatient(req, res)) return;
  const r = await insights.buildReport(req.params.id, req.query.days);
  if (!r.days_recorded) return res.json({ note: 'Nothing has been recorded in this period yet.', provider: null, cached: false });
  const key = `${req.params.id}:${r.days}`;
  const fingerprint = JSON.stringify([r.totals, r.days_recorded]);
  const hit = noteCache.get(key);
  if (hit && hit.fingerprint === fingerprint && !req.query.fresh) return res.json({ ...hit.body, cached: true });
  const job = await enqueueSummary({ patientId: req.params.id, prompt: insights.reportPrompt(r), cacheKey: `report:${key}` });
  const done = await waitFor(job.id, 60000);
  if (!done || done.status !== 'done') return res.status(503).json({ error: 'Could not write the note just now. Try again in a minute.' });
  const body = { note: done.result.text.trim(), provider: done.result.provider, generated_at: new Date() };
  noteCache.set(key, { fingerprint, body });
  res.json({ ...body, cached: false });
}

// ---- #21 reminiscence: the family photo album --------------------------------------------------

const publicMemory = (m) => ({ id: m.id, image_url: m.imageUrl, caption: m.caption, added_by: m.creatorName, created_at: m.createdAt });

// GET /api/patients/:id/memories
async function listMemories(req, res) {
  if (!ownPatient(req, res)) return;
  const list = await prisma.memory.findMany({ where: { patientId: req.params.id }, orderBy: { createdAt: 'asc' }, take: 50 });
  res.json(list.map(publicMemory));
}

// POST /api/patients/:id/memories  { image: base64 (no data: prefix) | data URI, caption }
async function addMemory(req, res) {
  if (!ownPatient(req, res)) return;
  const caption = String(req.body?.caption || '').trim().slice(0, 200);
  let image = String(req.body?.image || '');
  if (!caption) return res.status(400).json({ error: 'Write a line about the photo' });
  if (!image) return res.status(400).json({ error: 'image is required' });
  if (image.length > 9 * 1024 * 1024) return res.status(413).json({ error: 'That photo is too large (keep it under about 6 MB)' });
  if (!image.startsWith('data:')) image = `data:image/jpeg;base64,${image}`;
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  // Resized on upload: a phone screen never needs more than ~1600 px, and it keeps the slideshow quick.
  const r = await cloudinary.uploader.upload(image, { folder: 'assist/memories', transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }] });
  const m = await prisma.memory.create({
    data: { patientId: req.params.id, imageUrl: r.secure_url, caption, createdBy: req.user.sub, creatorName: (user?.name || 'Family').split(' ')[0] },
  });
  res.status(201).json(publicMemory(m));
}

// PATCH /api/patients/:id/memories/:mid  { caption }
async function updateMemory(req, res) {
  if (!ownPatient(req, res)) return;
  const caption = String(req.body?.caption || '').trim().slice(0, 200);
  if (!caption) return res.status(400).json({ error: 'caption is required' });
  const r = await prisma.memory.updateMany({ where: { id: req.params.mid, patientId: req.params.id }, data: { caption } });
  if (!r.count) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}

// DELETE /api/patients/:id/memories/:mid
async function deleteMemory(req, res) {
  if (!ownPatient(req, res)) return;
  await prisma.memory.deleteMany({ where: { id: req.params.mid, patientId: req.params.id } });
  res.status(204).send();
}

// POST /api/patients/:id/album  { ids?: [] } — send the album (or chosen photos) to the phone as a narrated slideshow
async function sendAlbum(req, res) {
  if (!ownPatient(req, res)) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  const list = await prisma.memory.findMany({
    where: { patientId: req.params.id, ...(ids?.length && { id: { in: ids } }) },
    orderBy: { createdAt: 'asc' },
    take: 12,
  });
  if (!list.length) return res.status(400).json({ error: 'Add a photo to the album first' });
  let payload;
  try {
    payload = TYPES.album.clean({ title: req.body?.title, slides: list.map((m) => ({ image_url: m.imageUrl, caption: m.caption })) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const cmd = await prisma.deviceCommand.create({
    data: {
      patientId: req.params.id,
      type: 'album',
      payload: voice.wantsVoice('album') ? { ...payload, voice_pending: true } : payload,
      createdBy: req.user.sub,
      senderName: (user?.name || 'Family').split(' ')[0],
      expiresAt: new Date(Date.now() + 10 * 60000),
    },
  });
  if (voice.wantsVoice('album')) voice.prepareCommand(cmd);
  res.status(201).json({ id: cmd.id, type: 'album', status: cmd.status, slides: payload.slides.length, created_at: cmd.createdAt });
}

module.exports = { find, report, reportNote, listMemories, addMemory, updateMemory, deleteMemory, sendAlbum };
