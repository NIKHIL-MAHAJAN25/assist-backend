const prisma = require('../config/prisma');

// Phase 0: accepts a pre-computed descriptor directly. face-api.js integration (computing the
// descriptor from a reference image server-side) is Phase 2 — see decisions-log.md.
async function createEnrolledFace(req, res) {
  const { patient_id, name, reference_embedding } = req.body;
  if (!patient_id || !name || !Array.isArray(reference_embedding)) {
    return res.status(400).json({ error: 'patient_id, name, and reference_embedding (array) are required' });
  }

  const face = await prisma.enrolledFace.create({
    data: { patientId: patient_id, name, referenceEmbedding: reference_embedding },
  });

  res.status(201).json(face);
}

async function listEnrolledFaces(req, res) {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const faces = await prisma.enrolledFace.findMany({
    where: { patientId: patient_id },
    select: { id: true, patientId: true, name: true, createdAt: true },
  });

  res.json(faces);
}

async function deleteEnrolledFace(req, res) {
  const { id } = req.params;
  await prisma.enrolledFace.delete({ where: { id } });
  res.status(204).send();
}

module.exports = { createEnrolledFace, listEnrolledFaces, deleteEnrolledFace };
