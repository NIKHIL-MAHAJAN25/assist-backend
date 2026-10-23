const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createEnrolledFace,
  listEnrolledFaces,
  deleteEnrolledFace,
  peopleSeen,
  faceSettings,
} = require('../controllers/enrolledFaceController');

const router = express.Router();
const family = [requireAuth, requireRole('family_caregiver')];

router.post('/enrolled-faces', ...family, createEnrolledFace);
router.get('/enrolled-faces', ...family, listEnrolledFaces);
router.delete('/enrolled-faces/:id', ...family, deleteEnrolledFace);
router.get('/patients/:id/people-seen', ...family, peopleSeen);
router.get('/patients/:id/face-settings', ...family, faceSettings);
router.put('/patients/:id/face-settings', ...family, faceSettings);

module.exports = router;
