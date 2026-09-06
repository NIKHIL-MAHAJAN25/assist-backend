const express = require('express');
const { requireAuth, requireDeviceAuth } = require('../middleware/auth');
const { getTodayQuiz, recordAttempt, getQuizHistory } = require('../controllers/quizController');

const router = express.Router();

// today/attempts are called by the companion app on the patient's behalf (device API key) --
// there is no patient login flow. history is for the family_caregiver dashboard (JWT).
router.get('/quiz/today', requireDeviceAuth, getTodayQuiz);
router.post('/quiz/attempts', requireDeviceAuth, recordAttempt);
router.get('/quiz/history', requireAuth, getQuizHistory);

module.exports = router;
