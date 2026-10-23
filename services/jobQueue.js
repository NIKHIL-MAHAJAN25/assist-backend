const prisma = require('../config/prisma');
const { uploadFrame } = require('./cloudinaryService');
const { analyzeFrameWithPrompt, generateText } = require('./geminiService');
const { framePrompt, validateFrame } = require('./prompts');
const journal = require('./journalService');
const { decideFor } = require('./decisionService');
const faces = require('./faceService');

// Shared work queue for the AI helpers (decisions-log 2026-10-17: 4 Claude + 4 Codex workers, Gemini last).
//
//   AI_PROVIDER=workers  frames/summaries wait for a helper; Gemini takes over if none answers in time.
//   AI_PROVIDER=gemini   (default) the backend answers with Gemini straight away, no helpers needed.
//
// Helpers claim with FOR UPDATE SKIP LOCKED, so two can never take the same job. A bad answer is retried
// once on the other provider, then Gemini. Stale frames are dropped: the family wants now, not a backlog.

const MODE = () => (process.env.AI_PROVIDER || 'gemini').toLowerCase();
const FALLBACK_AFTER_S = { frame: 20, summary: 25, agent: 15, story: 25 };
const FRAME_STALE_S = 90;
const RUNNING_TIMEOUT_S = 120;
const GEMINI_FRAME_GAP_MS = 10000;

const uploads = new Map(); // jobId -> Promise<publicId|null>, Cloudinary upload started at ingest
let lastGeminiFrame = 0;

// ---- enqueue --------------------------------------------------------------------------------

async function enqueueFrame({ device, image, capturedAt, commandId }) {
  const tail = await journal.tail(device.patientId, 10).catch(() => []);
  const job = await prisma.aiJob.create({
    data: {
      kind: 'frame',
      patientId: device.patientId,
      payload: { device_id: device.id, captured_at: capturedAt.toISOString(), image, prompt: framePrompt(tail), ...(commandId && { command_id: commandId }) },
    },
  });
  // Upload in the background; a Cloudinary failure must never lose the moment itself.
  uploads.set(job.id, uploadFrame(image).catch((e) => { console.error('[upload]', e.message); return null; }));
  if (MODE() !== 'workers') runFallback(job.id).catch((e) => console.error('[gemini]', e.message));
  return job;
}

// Bedtime story (#18): written from the journal, ahead of frames.
async function enqueueStory({ patientId, prompt }) {
  const job = await prisma.aiJob.create({ data: { kind: 'story', patientId, payload: { prompt } } });
  if (MODE() !== 'workers') runFallback(job.id).catch((e) => console.error('[gemini]', e.message));
  return job;
}

// The family Assistant: a person is waiting, so it jumps the queue like a summary.
async function enqueueAgent({ patientId, prompt }) {
  const job = await prisma.aiJob.create({ data: { kind: 'agent', patientId, payload: { prompt } } });
  if (MODE() !== 'workers') runFallback(job.id).catch((e) => console.error('[gemini]', e.message));
  return job;
}

async function enqueueSummary({ patientId, prompt, cacheKey }) {
  const job = await prisma.aiJob.create({ data: { kind: 'summary', patientId, payload: { prompt, cache_key: cacheKey } } });
  if (MODE() !== 'workers') runFallback(job.id).catch((e) => console.error('[gemini]', e.message));
  return job;
}

// ---- helpers' side ---------------------------------------------------------------------------

async function claim(provider, workerId) {
  const rows = await prisma.$queryRaw`
    UPDATE ai_jobs SET status = 'running', started_at = now(), provider = ${provider}, worker_id = ${workerId},
           attempts = attempts + 1
    WHERE id = (
      SELECT id FROM ai_jobs
      WHERE status = 'queued' AND (avoid_provider IS NULL OR avoid_provider <> ${provider})
      ORDER BY (kind <> 'frame') DESC, (payload->>'command_id') IS NOT NULL DESC, created_at DESC
      LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, kind, payload`;
  if (!rows.length) return null;
  const j = rows[0];
  return { id: j.id, kind: j.kind, prompt: j.payload.prompt, image: j.kind === 'frame' ? j.payload.image : undefined };
}

// Put a job back untouched (its helper vanished before receiving it).
async function release(jobId) {
  await prisma.aiJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: { status: 'queued', workerId: null, provider: null, startedAt: null, attempts: { decrement: 1 } },
  });
}

async function complete(jobId, workerId, { ok, output, error, ms }) {
  const job = await prisma.aiJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'running' || job.workerId !== workerId) return { accepted: false };

  if (ok && job.kind === 'frame') {
    const v = validateFrame(output);
    if (v.ok) {
      await finishFrame(job, v.value, { provider: job.provider, ms });
      return { accepted: true };
    }
    error = v.error;
  } else if (ok && job.kind !== 'frame') {
    const text = String(output || '').trim();
    if (text.length > (job.kind === 'agent' ? 2 : 20)) {
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'done', result: { text, provider: job.provider, ms }, finishedAt: new Date() } });
      return { accepted: true };
    }
    error = 'empty summary';
  }

  await retryOrFallback(job, error || 'worker reported failure');
  return { accepted: true };
}

// ---- finishing -------------------------------------------------------------------------------

async function finishFrame(job, value, { provider, ms }) {
  const imagePublicId = (await uploads.get(job.id)) ?? null;
  uploads.delete(job.id);
  const entry = await prisma.logEntry.create({
    data: {
      patientId: job.patientId,
      deviceId: job.payload.device_id,
      entryType: 'frame',
      timestamp: new Date(job.payload.captured_at),
      payload: { ...value, analysed_by: provider },
      requiresAttention: value.requires_attention,
      imagePublicId,
    },
  });
  const { image, ...rest } = job.payload; // drop the photo bytes from the queue row
  await prisma.aiJob.update({
    where: { id: job.id },
    data: { status: 'done', payload: rest, result: { log_entry_id: entry.id, provider, ms }, finishedAt: new Date() },
  });
  decideFor(entry.id);
  journal.writeDay(job.patientId).catch((e) => console.error('[journal]', e.message));
  // Who's in the photo (enrolled family). Runs on every photo — the description model often calls a
  // face right up at the camera "no one in the room". Runs after the moment is saved, so a slow or
  // failed face check never delays or loses the moment itself.
  if (image) {
    faces.recogniseEntry(entry, image)
      .then(async (r) => {
        if (!r?.faces) return;
        if (r.people.length) await faces.announceVisitors(entry, r.people);
        await journal.writeDay(job.patientId);
      })
      .catch((e) => console.error('[faces]', e.message));
  }
  // A fall on camera: ask her straight away whether she's okay (#15).
  if (value.activity_key === 'fallen') {
    require('./fallCheck').start(job.patientId, { logEntryId: entry.id }).catch((e) => console.error('[fall]', e.message));
  }
  if (job.payload.command_id) {
    // "Take a photo now" from the Assistant: hand the result back to the family's card.
    const cmd = await prisma.deviceCommand.findUnique({ where: { id: job.payload.command_id } });
    if (cmd) {
      await prisma.deviceCommand.update({
        where: { id: cmd.id },
        data: { status: 'done', doneAt: new Date(), payload: { ...cmd.payload, log_entry_id: entry.id, image_public_id: imagePublicId, activity: value.activity, person_state: value.person_state, objects: value.objects_of_note } },
      });
    }
  }
  return entry;
}

async function retryOrFallback(job, error) {
  if (job.attempts < 2 && job.provider !== 'gemini') {
    await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'queued', avoidProvider: job.provider, error, workerId: null } });
  } else {
    await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'queued', error } });
    await runFallback(job.id);
  }
}

// Gemini answers a job itself. Claims it atomically like a helper would.
async function runFallback(jobId) {
  const claimed = await prisma.aiJob.updateMany({
    where: { id: jobId, status: 'queued' },
    data: { status: 'running', provider: 'gemini', workerId: 'backend', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return;
  const job = await prisma.aiJob.findUnique({ where: { id: jobId } });
  const started = Date.now();
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY for fallback');
    if (job.kind === 'frame') {
      if (!job.payload.command_id && Date.now() - lastGeminiFrame < GEMINI_FRAME_GAP_MS) {
        await drop(job, 'gemini throttle');
        return;
      }
      lastGeminiFrame = Date.now();
      const raw = await analyzeFrameWithPrompt({ base64Image: job.payload.image, prompt: job.payload.prompt });
      const v = validateFrame(raw);
      if (!v.ok) throw new Error(v.error);
      await finishFrame(job, v.value, { provider: 'gemini', ms: Date.now() - started });
    } else {
      const text = await generateText(job.payload.prompt);
      await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'done', result: { text, provider: 'gemini', ms: Date.now() - started }, finishedAt: new Date() } });
    }
  } catch (e) {
    uploads.delete(job.id);
    await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'failed', error: e.message, finishedAt: new Date() } });
    console.error(`[gemini] ${job.kind} ${job.id}: ${e.message}`);
  }
}

async function drop(job, why) {
  uploads.delete(job.id);
  const { image, ...rest } = job.payload;
  await prisma.aiJob.update({ where: { id: job.id }, data: { status: 'dropped', error: why, payload: rest, finishedAt: new Date() } });
}

// ---- housekeeping ----------------------------------------------------------------------------

async function sweep() {
  const now = Date.now();
  const queued = await prisma.aiJob.findMany({ where: { status: 'queued' }, select: { id: true, kind: true, createdAt: true, payload: true } });
  for (const j of queued) {
    const age = (now - j.createdAt.getTime()) / 1000;
    if (j.kind === 'frame' && age > FRAME_STALE_S && !j.payload.command_id) await drop(j, 'stale');
    else if (age > FALLBACK_AFTER_S[j.kind]) await runFallback(j.id);
  }
  // A helper that died mid-job: give the job back (or to Gemini).
  const stuck = await prisma.aiJob.findMany({
    where: { status: 'running', workerId: { not: 'backend' }, startedAt: { lt: new Date(now - RUNNING_TIMEOUT_S * 1000) } },
  });
  for (const j of stuck) await retryOrFallback(j, 'helper timed out');
  // Finished rows are only useful for a day.
  await prisma.aiJob.deleteMany({ where: { status: { in: ['done', 'failed', 'dropped'] }, finishedAt: { lt: new Date(now - 86400000) } } });
}

async function waitFor(jobId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const j = await prisma.aiJob.findUnique({ where: { id: jobId } });
    if (!j || ['done', 'failed', 'dropped'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  return prisma.aiJob.findUnique({ where: { id: jobId } });
}

async function stats() {
  const since = new Date(Date.now() - 3600 * 1000);
  const rows = await prisma.aiJob.groupBy({ by: ['status', 'provider'], where: { createdAt: { gte: since } }, _count: true });
  return { mode: MODE(), last_hour: rows.map((r) => ({ status: r.status, provider: r.provider, count: r._count })) };
}

function start() {
  const tick = () => sweep().catch((e) => console.error('[queue]', e.message));
  setInterval(tick, 3000).unref();
}

module.exports = { start, enqueueFrame, enqueueSummary, enqueueAgent, enqueueStory, claim, release, complete, waitFor, stats, MODE };
