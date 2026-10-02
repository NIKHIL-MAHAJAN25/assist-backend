const express = require('express');
const { login, registerDeviceHandler } = require('../controllers/authController');
const { getDeviceContext } = require('../controllers/deviceController');
const { requireDeviceAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/auth/login', login);
router.post('/devices/register', registerDeviceHandler);
router.get('/devices/me', requireDeviceAuth, getDeviceContext);

module.exports = router;
