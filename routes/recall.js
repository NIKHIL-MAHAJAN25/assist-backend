const express = require('express');
const { requireDeviceAuth } = require('../middleware/auth');
const { recallQuery, assistClarify } = require('../controllers/recallController');

const router = express.Router();

router.post('/recall/query', requireDeviceAuth, recallQuery);
router.post('/assist/clarify', requireDeviceAuth, assistClarify);

module.exports = router;
