const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { listLogEntries, getLogEntry, updateLogEntry } = require('../controllers/logEntryController');

const router = express.Router();

router.get('/log-entries', requireAuth, listLogEntries);
router.get('/log-entries/:id', requireAuth, getLogEntry);
router.patch('/log-entries/:id', requireAuth, updateLogEntry);

module.exports = router;
