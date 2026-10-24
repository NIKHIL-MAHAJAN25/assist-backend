const prisma = require('../config/prisma');
const { quizFor, badQuestion } = require('../services/patientMemory');

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
    include: { _count: { select: { attempts: true } } },
  });
  // Questions from the old generator ("what was in front of your camera at 4:30?") are replaced, as
  // long as nobody has answered them yet.
  const stale = existing.filter((q) => q._count.attempts === 0 && badQuestion(q));
  if (stale.length) await prisma.quizQuestion.deleteMany({ where: { id: { in: stale.map((q) => q.id) } } });
  const keep = existing.filter((q) => !stale.includes(q)).map(({ _count, ...q }) => q);
  if (keep.length > 0) return res.json(keep);

  const patient = await prisma.patient.findUnique({ where: { id: patient_id }, select: { id: true, name: true } });
  const generated = await quizFor(patient);
  if (!generated.length) return res.json([]);

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
