const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createEnrolledFace,
  listEnrolledFaces,
  deleteEnrolledFace,
} = require('../controllers/enrolledFaceController');

const router = express.Router();

router.post('/enrolled-faces', requireAuth, requireRole('family_caregiver'), createEnrolledFace);
router.get('/enrolled-faces', requireAuth, requireRole('family_caregiver'), listEnrolledFaces);
router.delete('/enrolled-faces/:id', requireAuth, requireRole('family_caregiver'), deleteEnrolledFace);

module.exports = router;
