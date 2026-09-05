const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getTodayQuiz, recordAttempt, getQuizHistory } = require('../controllers/quizController');

const router = express.Router();

router.get('/quiz/today', requireAuth, getTodayQuiz);
router.post('/quiz/attempts', requireAuth, recordAttempt);
router.get('/quiz/history', requireAuth, getQuizHistory);

module.exports = router;
