const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const a = require('../controllers/accountController');
const { listDecisions } = require('../controllers/decisionController');
const { getSummary, getJournal } = require('../controllers/summaryController');
const assistant = require('../controllers/assistantController');
const notifications = require('../controllers/notificationController');
const demo = require('../controllers/demoController');
const { requireDeviceAuth } = require('../middleware/auth');

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
router.post('/patients/:id/assistant', ...family, assistant.ask);
router.get('/patients/:id/commands', ...family, assistant.listCommands);
router.post('/patients/:id/commands', ...family, assistant.createCommand);
router.post('/patients/:id/voice-notes', ...family, assistant.uploadVoiceNote);
router.get('/patients/:id/notifications', ...family, notifications.list);
router.post('/patients/:id/broadcasts', ...family, notifications.broadcast);

// Demo kit (DEMO_MODE=1 only)
router.get('/demo/:id', ...family, demo.state);
router.post('/demo/:id/scenes/:name/save', ...family, demo.saveScene);
router.post('/demo/:id/scenes/:name/play', ...family, demo.playScene);
router.post('/demo/:id/walk', ...family, demo.walk);
router.post('/demo/:id/answer', ...family, demo.answer);
router.post('/demo/:id/reset', ...family, demo.reset);

router.get('/devices/commands', requireDeviceAuth, assistant.pullCommands);
router.post('/devices/commands/:cid/ack', requireDeviceAuth, assistant.ackCommand);

module.exports = router;
