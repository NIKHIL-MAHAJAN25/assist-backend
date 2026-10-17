const prisma = require('../config/prisma');
const { mode } = require('../services/decisionService');

// GET /api/patients/:id/decisions — how the decision layer has been answering (rules vs Drex).
async function listDecisions(req, res) {
  if (req.user.patient_id !== req.params.id) return res.status(403).json({ error: 'Forbidden for this patient' });
  const days = Math.min(Number(req.query.days) || 7, 30);
  const since = new Date(Date.now() - days * 86400000);

  const entries = await prisma.logEntry.findMany({
    where: { patientId: req.params.id, timestamp: { gte: since }, agentDecision: { not: null } },
    orderBy: { timestamp: 'desc' },
    take: 200,
  });
  const decided = entries.filter((e) => e.payload?.decision);
  const answered = decided.filter((e) => e.payload.decision.drex && !e.payload.decision.drex.error);
  const agreed = answered.filter((e) => e.payload.decision.agree);
  const ms = answered.map((e) => e.payload.decision.drex.ms).sort((a, b) => a - b);

  res.json({
    mode: mode(),
    model: process.env.DREX_MODEL || 'drex-latest',
    summary: {
      decisions: decided.length,
      drex_answered: answered.length,
      drex_errors: decided.filter((e) => e.payload.decision.drex?.error).length,
      agreement: answered.length ? Math.round((agreed.length / answered.length) * 100) : null,
      median_ms: ms.length ? ms[Math.floor(ms.length / 2)] : null,
    },
    recent: decided.slice(0, 20).map((e) => ({
      log_entry_id: e.id,
      timestamp: e.timestamp,
      entry_type: e.entryType,
      what: e.payload.activity || (e.entryType === 'geofence' ? (e.payload.inside_safe_zone ? 'Inside a safe place' : 'Outside the safe places') : e.entryType),
      rules: e.payload.decision.rules,
      drex: e.payload.decision.drex || null,
      agree: e.payload.decision.agree ?? null,
      decided_by: e.payload.decision.decided_by,
    })),
  });
}

module.exports = { listDecisions };
