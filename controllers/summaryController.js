const fs = require('fs/promises');
const path = require('path');
const prisma = require('../config/prisma');
const journal = require('../services/journalService');
const { summaryPrompt } = require('../services/prompts');
const { enqueueSummary, waitFor } = require('../services/jobQueue');

// GET /api/patients/:id/summary?range=today|morning|week — a few plain sentences about the day,
// written by a helper from the journal. Cached beside the journal until the journal changes.
const RANGES = ['today', 'morning', 'week'];

async function journalFor(patientId, range) {
  if (range === 'week') {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(await journal.readDay(patientId, new Date(Date.now() - i * 86400000)));
    return days.join('\n');
  }
  const text = await journal.readDay(patientId);
  if (range !== 'morning') return text;
  return text.split('\n').filter((l) => l.startsWith('#') || /^(0\d|1[01]):/.test(l)).join('\n');
}

async function getSummary(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });
  const range = RANGES.includes(req.query.range) ? req.query.range : 'today';

  const patient = await prisma.patient.findUnique({ where: { id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const first = patient.name.split(' ')[0];

  await journal.writeDay(id); // make sure today's file reflects the database right now
  const text = await journalFor(id, range);
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  if (!lines.length) {
    const when = range === 'week' ? 'this week' : 'yet today';
    return res.json({ range, summary: `Nothing has been recorded for ${first} ${when}.`, provider: null, generated_at: new Date(), cached: false });
  }

  const cacheFile = path.join(journal.JOURNAL_DIR, id, `summary-${journal.dayKey(new Date())}-${range}.json`);
  const fingerprint = `${lines.length}:${lines[lines.length - 1]}`;
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached.fingerprint === fingerprint && !req.query.fresh) return res.json({ ...cached.body, cached: true });
  } catch { /* no cache yet */ }

  const job = await enqueueSummary({ patientId: id, prompt: summaryPrompt({ firstName: first, range, journal: text }), cacheKey: cacheFile });
  const done = await waitFor(job.id, 60000);
  if (!done || done.status !== 'done') {
    return res.status(503).json({ error: 'Could not write the summary just now. Try again in a minute.' });
  }
  const body = { range, summary: done.result.text, provider: done.result.provider, generated_at: new Date(), journal_lines: lines.length };
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ fingerprint, body }), 'utf8').catch(() => {});
  res.json({ ...body, cached: false });
}

// GET /api/patients/:id/journal?date=YYYY-MM-DD — the raw journal, for the curious (and for demos).
async function getJournal(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });
  const day = req.query.date ? new Date(`${req.query.date}T12:00:00`) : new Date();
  if (Number.isNaN(day.getTime())) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  if (!req.query.date) await journal.writeDay(id);
  res.type('text/markdown').send(await journal.readDay(id, day));
}

module.exports = { getSummary, getJournal };
