const prisma = require('../config/prisma');

// Faces are enrolled as a 128-number fingerprint computed in the browser (or the app's hidden
// WebView) with face-api.js; the photo never leaves the device. The server matches those
// fingerprints against faces in camera photos (services/faceService.js).

const own = (req, patientId) => req.user.patient_id === patientId;

async function createEnrolledFace(req, res) {
  const { patient_id, name, reference_embedding } = req.body;
  if (!patient_id || !name || !Array.isArray(reference_embedding)) {
    return res.status(400).json({ error: 'patient_id, name, and reference_embedding (array) are required' });
  }
  if (!own(req, patient_id)) return res.status(403).json({ error: 'Forbidden for this patient' });

  const face = await prisma.enrolledFace.create({
    data: { patientId: patient_id, name, referenceEmbedding: reference_embedding },
  });

  res.status(201).json(face);
}

async function listEnrolledFaces(req, res) {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });
  if (!own(req, patient_id)) return res.status(403).json({ error: 'Forbidden for this patient' });

  const faces = await prisma.enrolledFace.findMany({
    where: { patientId: patient_id },
    select: { id: true, patientId: true, name: true, createdAt: true },
  });

  res.json(faces);
}

async function deleteEnrolledFace(req, res) {
  const { id } = req.params;
  const face = await prisma.enrolledFace.findUnique({ where: { id }, select: { patientId: true } });
  if (!face) return res.status(204).send();
  if (!own(req, face.patientId)) return res.status(403).json({ error: 'Forbidden for this patient' });
  // Recognitions point at the face; remove them first so the person can be deleted.
  await prisma.$transaction([
    prisma.logEntryFace.deleteMany({ where: { enrolledFaceId: id } }),
    prisma.enrolledFace.delete({ where: { id } }),
  ]);
  res.status(204).send();
}

// GET /api/patients/:id/people-seen — for each enrolled person: when the camera last recognised
// them, the photo, and how many times in the last 7 days.
async function peopleSeen(req, res) {
  if (!own(req, req.params.id)) return res.status(403).json({ error: 'Forbidden for this patient' });
  const since = new Date(Date.now() - 7 * 86400000);
  const faces = await prisma.enrolledFace.findMany({
    where: { patientId: req.params.id },
    select: {
      id: true,
      name: true,
      logs: {
        where: { logEntry: { timestamp: { gte: since } } },
        select: { logEntry: { select: { id: true, timestamp: true, imagePublicId: true, payload: true } } },
      },
    },
  });
  res.json(faces.map((f) => {
    const seen = f.logs.map((l) => l.logEntry).sort((a, b) => b.timestamp - a.timestamp);
    const last = seen[0];
    return {
      face_id: f.id,
      name: f.name,
      times_seen_7d: seen.length,
      last_seen_at: last?.timestamp || null,
      last_seen_entry_id: last?.id || null,
      last_seen_image: last?.imagePublicId || null,
      last_seen_doing: last?.payload?.activity || null,
    };
  }));
}

// GET/PUT /api/patients/:id/face-settings  { announce: boolean }
async function faceSettings(req, res) {
  if (!own(req, req.params.id)) return res.status(403).json({ error: 'Forbidden for this patient' });
  if (req.method === 'PUT') {
    if (typeof req.body?.announce !== 'boolean') return res.status(400).json({ error: 'announce must be true or false' });
    await prisma.patient.update({ where: { id: req.params.id }, data: { announceFaces: req.body.announce } });
  }
  const p = await prisma.patient.findUnique({ where: { id: req.params.id }, select: { announceFaces: true } });
  res.json({ announce: Boolean(p?.announceFaces), recognition: process.env.FACES !== 'off' });
}

module.exports = { createEnrolledFace, listEnrolledFaces, deleteEnrolledFace, peopleSeen, faceSettings };
