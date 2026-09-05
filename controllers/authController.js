const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { registerDevice } = require('../services/deviceService');

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { sub: user.id, role: user.role, patient_id: user.patientId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, role: user.role, patient_id: user.patientId },
  });
}

async function registerDeviceHandler(req, res) {
  const { patient_id, device_type, identifier } = req.body;
  if (!patient_id || !device_type || !identifier) {
    return res.status(400).json({ error: 'patient_id, device_type, and identifier are required' });
  }
  if (!['esp32cam', 'watch'].includes(device_type)) {
    return res.status(400).json({ error: 'device_type must be esp32cam or watch' });
  }

  const { deviceId, apiKey } = await registerDevice({
    patientId: patient_id,
    deviceType: device_type,
    identifier,
  });

  res.status(201).json({ device_id: deviceId, api_key: apiKey });
}

module.exports = { login, registerDeviceHandler };
