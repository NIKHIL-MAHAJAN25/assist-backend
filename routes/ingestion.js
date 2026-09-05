const express = require('express');
const { requireDeviceAuth } = require('../middleware/auth');
const { ingestFrame } = require('../controllers/frameController');
const { checkGeofence } = require('../controllers/geofenceController');
const { ingestHeartrateEvent } = require('../controllers/heartrateController');

const router = express.Router();

router.post('/frames', requireDeviceAuth, ingestFrame);
router.post('/geofence-check', requireDeviceAuth, checkGeofence);
router.post('/heartrate-events', requireDeviceAuth, ingestHeartrateEvent);

module.exports = router;
