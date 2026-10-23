const prisma = require('../config/prisma');

async function listLogEntries(req, res) {
  const { patient_id, type, from, to, acknowledged } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const entries = await prisma.logEntry.findMany({
    where: {
      patientId: patient_id,
      // Watch readings live on the Watch tab (GET /patients/:id/vitals), not in the log.
      ...(type ? { entryType: type } : { entryType: { not: 'heartrate' } }),
      ...((from || to) && {
        timestamp: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) }),
        },
      }),
      ...(acknowledged === 'true' && { acknowledgedAt: { not: null } }),
      ...(acknowledged === 'false' && { acknowledgedAt: null }),
    },
    orderBy: { timestamp: 'desc' },
  });

  res.json(entries);
}

async function getLogEntry(req, res) {
  const { id } = req.params;
  const entry = await prisma.logEntry.findUnique({ where: { id } });
  if (!entry) return res.status(404).json({ error: 'Log entry not found' });
  res.json(entry);
}

async function updateLogEntry(req, res) {
  const { id } = req.params;
  const { is_saved, acknowledged } = req.body;
  if (is_saved === undefined && acknowledged === undefined) {
    return res.status(400).json({ error: 'is_saved or acknowledged is required' });
  }

  const entry = await prisma.logEntry.update({
    where: { id },
    data: {
      ...(is_saved !== undefined && { isSaved: is_saved }),
      ...(acknowledged !== undefined && { acknowledgedAt: acknowledged ? new Date() : null }),
    },
  });
  res.json(entry);
}

module.exports = { listLogEntries, getLogEntry, updateLogEntry };
