const prisma = require('../config/prisma');
const { isInsideAnyZone } = require('../services/geofenceService');

async function checkGeofence(req, res) {
  const { device_id, lat, lng, timestamp } = req.body;
  if (!device_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'device_id, lat, and lng are required' });
  }

  const device = req.device;
  const zones = await prisma.geofenceZone.findMany({ where: { patientId: device.patientId } });
  const insideSafeZone = isInsideAnyZone(lat, lng, zones);

  const logEntry = await prisma.logEntry.create({
    data: {
      patientId: device.patientId,
      deviceId: device.id,
      entryType: 'geofence',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      payload: { lat, lng, inside_safe_zone: insideSafeZone },
      requiresAttention: !insideSafeZone,
    },
  });

  res.status(201).json({ log_entry_id: logEntry.id, inside_safe_zone: insideSafeZone });
}

async function createZone(req, res) {
  const { patient_id, name, center_lat, center_lng, radius_meters } = req.body;
  if (!patient_id || !name || center_lat === undefined || center_lng === undefined || !radius_meters) {
    return res.status(400).json({ error: 'patient_id, name, center_lat, center_lng, radius_meters are required' });
  }

  const zone = await prisma.geofenceZone.create({
    data: {
      patientId: patient_id,
      name,
      centerLat: center_lat,
      centerLng: center_lng,
      radiusMeters: radius_meters,
      createdBy: req.user.sub,
    },
  });

  res.status(201).json(zone);
}

async function listZones(req, res) {
  const { patient_id } = req.query;
  if (!patient_id) return res.status(400).json({ error: 'patient_id is required' });

  const zones = await prisma.geofenceZone.findMany({ where: { patientId: patient_id } });
  res.json(zones);
}

async function updateZone(req, res) {
  const { id } = req.params;
  const { name, center_lat, center_lng, radius_meters } = req.body;

  const zone = await prisma.geofenceZone.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(center_lat !== undefined && { centerLat: center_lat }),
      ...(center_lng !== undefined && { centerLng: center_lng }),
      ...(radius_meters !== undefined && { radiusMeters: radius_meters }),
    },
  });

  res.json(zone);
}

async function deleteZone(req, res) {
  const { id } = req.params;
  await prisma.geofenceZone.delete({ where: { id } });
  res.status(204).send();
}

module.exports = { checkGeofence, createZone, listZones, updateZone, deleteZone };
