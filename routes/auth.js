const express = require('express');
const { login, registerDeviceHandler } = require('../controllers/authController');

const router = express.Router();

router.post('/auth/login', login);
router.post('/devices/register', registerDeviceHandler);

module.exports = router;
