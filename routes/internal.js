const crypto = require('crypto');
const express = require('express');
const queue = require('../services/jobQueue');

// Routes for the AI helpers running on the same host. Two locks: a shared WORKER_TOKEN, and the request
// must not have come through the public proxy (Caddy adds X-Forwarded-For), so these never answer from
// the internet even if the token leaked.
const router = express.Router();

function onlyHelpers(req, res, next) {
  const token = process.env.WORKER_TOKEN || '';
  const given = String(req.get('x-worker-token') || '');
  const okToken = token.length >= 16 && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (!okToken || req.get('x-forwarded-for')) return res.status(404).json({ error: 'Not found' });
  next();
}

router.use(onlyHelpers);

// Long-poll: wait up to ~20 s for a job so idle helpers don't hammer the database.
router.post('/jobs/claim', async (req, res) => {
  const { provider, worker_id } = req.body || {};
  if (!['claude', 'codex'].includes(provider) || !worker_id) return res.status(400).json({ error: 'provider and worker_id required' });
  // Stop as soon as the helper hangs up, or a job would be claimed for nobody.
  let gone = false;
  res.on('close', () => { gone = true; });
  const until = Date.now() + 20000;
  while (Date.now() < until && !gone) {
    const job = await queue.claim(provider, String(worker_id));
    if (job && gone) {
      await queue.release(job.id);
      return;
    }
    if (job) return res.json(job);
    await new Promise((r) => setTimeout(r, 1000));
  }
  res.status(204).send();
});

router.post('/jobs/:id/result', async (req, res) => {
  const { worker_id, ok, output, error, ms } = req.body || {};
  const r = await queue.complete(req.params.id, String(worker_id || ''), { ok: !!ok, output, error, ms: Number(ms) || null });
  res.status(r.accepted ? 200 : 409).json(r);
});

router.get('/stats', async (req, res) => res.json(await queue.stats()));

module.exports = router;
