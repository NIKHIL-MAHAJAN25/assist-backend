const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getStatus } = require('../controllers/patientController');

const router = express.Router();

router.get('/patients/:id/status', requireAuth, requireRole('family_caregiver'), getStatus);

module.exports = router;
