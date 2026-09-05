const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for this role' });
    }
    next();
  };
}

async function requireDeviceAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!apiKey) return res.status(401).json({ error: 'Missing device API key' });

  const deviceId = req.body.device_id;
  if (!deviceId) return res.status(400).json({ error: 'device_id is required' });

  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) return res.status(401).json({ error: 'Unknown device' });

  const valid = await bcrypt.compare(apiKey, device.apiKeyHash);
  if (!valid) return res.status(401).json({ error: 'Invalid device API key' });

  req.device = device;
  next();
}

module.exports = { requireAuth, requireRole, requireDeviceAuth };
