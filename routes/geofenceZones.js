const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createZone, listZones, updateZone, deleteZone } = require('../controllers/geofenceController');

const router = express.Router();

router.post('/geofence-zones', requireAuth, requireRole('family_caregiver'), createZone);
router.get('/geofence-zones', requireAuth, requireRole('family_caregiver'), listZones);
router.patch('/geofence-zones/:id', requireAuth, requireRole('family_caregiver'), updateZone);
router.delete('/geofence-zones/:id', requireAuth, requireRole('family_caregiver'), deleteZone);

module.exports = router;
