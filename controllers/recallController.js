const prisma = require('../config/prisma');
const { answerRecallQuery, clarifyTranscript } = require('../services/geminiService');

async function recallQuery(req, res) {
  const { query_text } = req.body;
  if (!query_text) return res.status(400).json({ error: 'query_text is required' });

  const device = req.device;
  const recentEntries = await prisma.logEntry.findMany({
    where: { patientId: device.patientId },
    orderBy: { timestamp: 'desc' },
    take: 50,
  });

  const answerText = await answerRecallQuery(query_text, recentEntries);
  res.json({ answer_text: answerText });
}

async function assistClarify(req, res) {
  const { raw_transcript } = req.body;
  if (!raw_transcript) return res.status(400).json({ error: 'raw_transcript is required' });

  const clarifiedResponse = await clarifyTranscript(raw_transcript);
  res.json({ clarified_response: clarifiedResponse });
}

module.exports = { recallQuery, assistClarify };
