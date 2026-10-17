const express = require('express');
const { login, registerDeviceHandler } = require('../controllers/authController');
const { getDeviceContext } = require('../controllers/deviceController');
const { requireAuth, requireRole, requireDeviceAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/auth/login', login);
// Family-only now: the patient's phone pairs with a short code instead (POST /devices/pair).
router.post('/devices/register', requireAuth, requireRole('family_caregiver'), registerDeviceHandler);
router.get('/devices/me', requireDeviceAuth, getDeviceContext);

module.exports = router;
