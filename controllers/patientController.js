const prisma = require('../config/prisma');
const { getPatientStatus } = require('../services/patientStatusService');

async function getStatus(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });

  const patient = await prisma.patient.findUnique({ where: { id } });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });

  const status = await getPatientStatus(patient);
  res.json(status);
}

module.exports = { getStatus };
