const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getStatus } = require('../controllers/patientController');
const { getTag, updateTag, rotateTag } = require('../controllers/tagController');

const router = express.Router();

router.get('/patients/:id/status', requireAuth, requireRole('family_caregiver'), getStatus);
router.get('/patients/:id/tag', requireAuth, requireRole('family_caregiver'), getTag);
router.put('/patients/:id/tag', requireAuth, requireRole('family_caregiver'), updateTag);
router.post('/patients/:id/tag/rotate', requireAuth, requireRole('family_caregiver'), rotateTag);

module.exports = router;
