const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const a = require('../controllers/accountController');
const { listDecisions } = require('../controllers/decisionController');
const { getSummary, getJournal } = require('../controllers/summaryController');

const router = express.Router();
const family = [requireAuth, requireRole('family_caregiver')];

router.post('/auth/signup', a.signup);
router.post('/auth/join', a.join);
router.get('/invites/:code', a.previewInvite);
router.post('/devices/pair', a.pairDevice);

router.get('/patients/:id/caregivers', ...family, a.listCaregivers);
router.get('/patients/:id/invites', ...family, a.listInvites);
router.post('/patients/:id/invites', ...family, a.createInvite);
router.delete('/patients/:id/invites/:code', ...family, a.revokeInvite);
router.get('/patients/:id/decisions', ...family, listDecisions);
router.get('/patients/:id/summary', ...family, getSummary);
router.get('/patients/:id/journal', ...family, getJournal);

module.exports = router;
