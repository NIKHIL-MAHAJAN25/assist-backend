const prisma = require('../config/prisma');
const { ensureTag, publicBase } = require('../services/tagService');

// What a device needs to know about the person it serves: their name (so the phone can greet
// them) and their safe places (so "Help me get home" can point somewhere real).
async function getDeviceContext(req, res) {
  const patient = await prisma.patient.findUnique({
    where: { id: req.device.patientId },
    include: { geofenceZones: true },
  });
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  const tagged = await ensureTag(patient.id);

  res.json({
    patient: { id: patient.id, name: patient.name },
    // The phone answers NFC taps with this link (it acts as the emergency tag itself).
    tag_url: tagged?.tagCode ? `${publicBase(req)}/t/${tagged.tagCode}` : null,
    places: patient.geofenceZones.map((z) => ({
      id: z.id,
      name: z.name,
      center_lat: z.centerLat,
      center_lng: z.centerLng,
      radius_meters: z.radiusMeters,
    })),
  });
}

module.exports = { getDeviceContext };
