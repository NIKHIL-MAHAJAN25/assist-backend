const prisma = require('../config/prisma');
const { generateQuizQuestions } = require('../services/geminiService');

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

async function getTodayQuiz(req, res) {
  const patient_id = req.device.patientId;

  const today = new Date();
  const existing = await prisma.quizQuestion.findMany({
    where: { patientId: patient_id, date: { gte: startOfDay(today), lte: endOfDay(today) } },
  });
  if (existing.length > 0) return res.json(existing);

  const todaysEntries = await prisma.logEntry.findMany({
    where: { patientId: patient_id, timestamp: { gte: startOfDay(today), lte: endOfDay(today) } },
    orderBy: { timestamp: 'asc' },
  });

  if (todaysEntries.length === 0) return res.json([]);

  const generated = await generateQuizQuestions(todaysEntries);

  const created = await prisma.$transaction(
    generated.map((q) =>
      prisma.quizQuestion.create({
        data: {
          patientId: patient_id,
          question: q.question,
          correctAnswer: q.correct_answer,
          sourceLogEntryId: q.source_log_entry_id,
        },
      })
    )
  );

  res.status(201).json(created);
}

async function recordAttempt(req, res) {
  const { quiz_question_id, answered, correct } = req.body;
  if (!quiz_question_id || answered === undefined || correct === undefined) {
    return res.status(400).json({ error: 'quiz_question_id, answered, and correct are required' });
  }

  const question = await prisma.quizQuestion.findUnique({ where: { id: quiz_question_id } });
  if (!question || question.patientId !== req.device.patientId) {
    return res.status(404).json({ error: 'Quiz question not found' });
  }

  const attempt = await prisma.quizAttempt.create({
    data: { quizQuestionId: quiz_question_id, answered, correct },
  });

  res.status(201).json(attempt);
}

async function getQuizHistory(req, res) {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const questions = await prisma.quizQuestion.findMany({
    where: { patientId: patient_id },
    include: { attempts: true },
    orderBy: { date: 'desc' },
  });

  res.json(questions);
}

module.exports = { getTodayQuiz, recordAttempt, getQuizHistory };
