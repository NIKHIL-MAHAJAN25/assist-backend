const prisma = require('../config/prisma');
const { clarifyTranscript } = require('../services/geminiService');
const { answerQuestion } = require('../services/patientMemory');

async function recallQuery(req, res) {
  const { query_text } = req.body;
  if (!query_text) return res.status(400).json({ error: 'query_text is required' });

  // Answered from today's moments by the helper queue (Claude / Codex workers, Gemini as fallback);
  // never fails — the patient gets a plain, true answer even if no helper replies.
  const patient = await prisma.patient.findUnique({ where: { id: req.device.patientId }, select: { id: true, name: true } });
  const answerText = await answerQuestion(patient, String(query_text).slice(0, 300));
  res.json({ answer_text: answerText });
}

async function assistClarify(req, res) {
  const { raw_transcript } = req.body;
  if (!raw_transcript) return res.status(400).json({ error: 'raw_transcript is required' });

  const clarifiedResponse = await clarifyTranscript(raw_transcript);
  res.json({ clarified_response: clarifiedResponse });
}

module.exports = { recallQuery, assistClarify };
