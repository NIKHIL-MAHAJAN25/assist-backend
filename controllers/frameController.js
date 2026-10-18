const { enqueueFrame } = require('../services/jobQueue');

// A photo goes on the helper queue and the phone gets an answer at once (the phone ignores the body).
// The log entry, decision and journal line are written when a helper — or the Gemini fallback — answers.
// Response keeps the old shape for the app: log_entry_id carries the job id until the entry exists.
async function ingestFrame(req, res) {
  const { device_id, image, captured_at } = req.body;
  if (!device_id || !image) return res.status(400).json({ error: 'device_id and image are required' });

  const job = await enqueueFrame({ device: req.device, image, capturedAt: captured_at ? new Date(captured_at) : new Date() });
  res.status(202).json({ log_entry_id: job.id, requires_attention: false, queued: true });
}

module.exports = { ingestFrame };
