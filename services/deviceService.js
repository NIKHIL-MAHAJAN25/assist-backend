const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

async function registerDevice({ patientId, deviceType, identifier }) {
  const apiKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(apiKey, 10);

  const device = await prisma.device.create({
    data: { patientId, deviceType, identifier, apiKeyHash },
  });

  return { deviceId: device.id, apiKey };
}

module.exports = { registerDevice };
