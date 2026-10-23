const watch = require('../services/watchService');
const demo = require('../services/demoService');

function ownPatient(req, res) {
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

// GET /api/patients/:id/vitals?range=today|24h|7d — everything the Watch tab shows.
async function vitals(req, res) {
  if (!ownPatient(req, res)) return;
  res.json(await watch.vitals(req.params.id, String(req.query.range || 'today')));
}

// POST /api/demo/:id/watch  { scenario: normal|confusion|emergency|sos|stop } — a simulated watch
// (DEMO_MODE=1) that sends a reading every 5 s through the real paths.
async function demoWatch(req, res) {
  if (!demo.isDemoMode()) return res.status(403).json({ error: 'Demo mode is off (set DEMO_MODE=1 on the server)' });
  if (!ownPatient(req, res)) return;
  const scenario = String(req.body?.scenario || '');
  if (scenario === 'stop') return res.json(watch.stopSim(req.params.id));
  try {
    res.json(await watch.simulate(req.params.id, scenario));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// POST /api/demo/:id/watch/history { days } — a week of readings for the 7-day chart. DELETE removes them.
async function demoWatchHistory(req, res) {
  if (!demo.isDemoMode()) return res.status(403).json({ error: 'Demo mode is off (set DEMO_MODE=1 on the server)' });
  if (!ownPatient(req, res)) return;
  if (req.method === 'DELETE') return res.json(await watch.clearHistory(req.params.id));
  res.json(await watch.seedHistory(req.params.id, Math.min(14, Number(req.body?.days) || 7)));
}

module.exports = { vitals, demoWatch, demoWatchHistory };
