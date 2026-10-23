const watch = require('../services/watchService');

// Section 8.5 — scripted scenario data from the watch app, not live sensor polling.
async function ingestHeartrateEvent(req, res) {
  const { device_id, scenario, heart_rate, motion_pattern, timestamp, battery } = req.body;
  if (!device_id || !scenario) return res.status(400).json({ error: 'device_id and scenario are required' });
  if (!watch.SCENARIOS.includes(scenario)) {
    return res.status(400).json({ error: 'scenario must be normal, confusion, emergency or sos' });
  }
  const logEntry = await watch.recordReading(req.device, { scenario, heart_rate, motion_pattern, timestamp, battery });
  res.status(201).json({ log_entry_id: logEntry.id });
}

module.exports = { ingestHeartrateEvent };
