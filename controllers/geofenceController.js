const prisma = require('../config/prisma');
const { isInsideAnyZone } = require('../services/geofenceService');
const { decideFor } = require('../services/decisionService');
const { isWalkActive } = require('../services/demoService');
const sms = require('../services/smsService');

const REFLAG_MINUTES = 30;

async function checkGeofence(req, res) {
  const { device_id, lat, lng, timestamp } = req.body;
  if (!device_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'device_id, lat, and lng are required' });
  }
  // During a simulated walk (demo kit) the real phone's pings are set aside so the two don't fight.
  if (isWalkActive(req.device.patientId) && !req.device.identifier.startsWith('demo:')) {
    return res.status(202).json({ ignored: 'demo walk in progress' });
  }
  const r = await recordPing(req.device, Number(lat), Number(lng), timestamp ? new Date(timestamp) : new Date());
  res.status(201).json(r);
}

/** Store one location ping and flag it when they leave (or stay out of) the safe places. */
async function recordPing(device, lat, lng, at = new Date(), extra = {}) {
  const zones = await prisma.geofenceZone.findMany({ where: { patientId: device.patientId } });
  const insideSafeZone = isInsideAnyZone(lat, lng, zones);

  // The phone pings every minute. Flag the moment she leaves, then at most one reminder every
  // REFLAG_MINUTES while she stays out — not one alert per ping.
  let requiresAttention = false;
  let justLeft = false;
  if (!insideSafeZone) {
    const [previous, lastFlag] = await Promise.all([
      prisma.logEntry.findFirst({
        where: { patientId: device.patientId, entryType: 'geofence' },
        orderBy: { timestamp: 'desc' },
      }),
      prisma.logEntry.findFirst({
        where: { patientId: device.patientId, entryType: 'geofence', requiresAttention: true },
        orderBy: { timestamp: 'desc' },
      }),
    ]);
    justLeft = !previous || previous.payload?.inside_safe_zone !== false;
    const reminderDue = !lastFlag || at - lastFlag.timestamp >= REFLAG_MINUTES * 60000;
    requiresAttention = justLeft || reminderDue;
  }

  const logEntry = await prisma.logEntry.create({
    data: {
      patientId: device.patientId,
      deviceId: device.id,
      entryType: 'geofence',
      timestamp: at,
      payload: { lat, lng, inside_safe_zone: insideSafeZone, ...extra },
      requiresAttention,
    },
  });

  // Only ask the decision layer about pings that change something; routine in-zone pings stay rules-only.
  if (requiresAttention) decideFor(logEntry.id);
  if (justLeft) {
    const p = await prisma.patient.findUnique({ where: { id: device.patientId }, select: { name: true } });
    sms.quietly(device.patientId, 'left_safe_area', `${(p?.name || 'They').split(' ')[0]} has left the safe places.`);
  }
  return { log_entry_id: logEntry.id, inside_safe_zone: insideSafeZone };
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

module.exports = { recordPing, checkGeofence, createZone, listZones, updateZone, deleteZone };
