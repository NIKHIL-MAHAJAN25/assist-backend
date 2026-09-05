const prisma = require('../config/prisma');

async function listLogEntries(req, res) {
  const { patient_id, type, from, to } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const entries = await prisma.logEntry.findMany({
    where: {
      patientId: patient_id,
      ...(type && { entryType: type }),
      ...((from || to) && {
        timestamp: {
          ...(from && { gte: new Date(from) }),
          ...(to && { lte: new Date(to) }),
        },
      }),
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
  const { is_saved } = req.body;
  if (is_saved === undefined) return res.status(400).json({ error: 'is_saved is required' });

  const entry = await prisma.logEntry.update({ where: { id }, data: { isSaved: is_saved } });
  res.json(entry);
}

module.exports = { listLogEntries, getLogEntry, updateLogEntry };
