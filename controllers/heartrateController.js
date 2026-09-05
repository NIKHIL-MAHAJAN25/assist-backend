const prisma = require('../config/prisma');

// Section 8.5 — scripted scenario data from the watch app, not live sensor polling.
async function ingestHeartrateEvent(req, res) {
  const { device_id, scenario, heart_rate, motion_pattern, timestamp } = req.body;
  if (!device_id || !scenario) return res.status(400).json({ error: 'device_id and scenario are required' });
  if (!['normal', 'confusion', 'emergency'].includes(scenario)) {
    return res.status(400).json({ error: 'scenario must be normal, confusion, or emergency' });
  }

  const device = req.device;
  const logEntry = await prisma.logEntry.create({
    data: {
      patientId: device.patientId,
      deviceId: device.id,
      entryType: 'heartrate',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      payload: { scenario, heart_rate, motion_pattern },
      requiresAttention: scenario === 'emergency',
    },
  });

  res.status(201).json({ log_entry_id: logEntry.id });
}

module.exports = { ingestHeartrateEvent };
