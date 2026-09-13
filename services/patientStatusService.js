const prisma = require('../config/prisma');
const { distanceMeters } = require('./geofenceService');

// Data on this route drives a "is the person okay right now" dashboard. A gap in updates is a
// bigger red flag than any single reading, so we treat "haven't heard from the devices in over
// 45 minutes" as stale -- long enough to ride out a normal connectivity blip between frames,
// short enough that a real outage surfaces well within one caregiver's check-in cadence.
const STALE_THRESHOLD_MINUTES = 45;

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Zones can overlap (e.g. "Home" containing "Bedroom"). The smallest-radius match is the most
// specific description of where the patient actually is, so ties resolve to it.
function resolveZone(lat, lng, zones) {
  let best = null;
  for (const zone of zones) {
    if (distanceMeters(lat, lng, zone.centerLat, zone.centerLng) <= zone.radiusMeters) {
      if (!best || zone.radiusMeters < best.radiusMeters) best = zone;
    }
  }
  return best;
}

async function getPatientStatus(patient) {
  const patientId = patient.id;
  const now = new Date();
  const todayStart = startOfLocalDay(now);

  const [
    lastEntry,
    lastFrame,
    lastGeofence,
    needsAttentionCount,
    zones,
    todayEntryCount,
    todayQuizQuestions,
  ] = await Promise.all([
    prisma.logEntry.findFirst({ where: { patientId }, orderBy: { timestamp: 'desc' } }),
    prisma.logEntry.findFirst({
      where: { patientId, entryType: 'frame' },
      orderBy: { timestamp: 'desc' },
    }),
    prisma.logEntry.findFirst({
      where: { patientId, entryType: 'geofence' },
      orderBy: { timestamp: 'desc' },
    }),
    prisma.logEntry.count({
      where: { patientId, requiresAttention: true, acknowledgedAt: null },
    }),
    prisma.geofenceZone.findMany({ where: { patientId } }),
    prisma.logEntry.count({ where: { patientId, timestamp: { gte: todayStart } } }),
    prisma.quizQuestion.findMany({
      where: { patientId, date: { gte: todayStart } },
      include: { attempts: true },
    }),
  ]);

  const lastUpdate = lastEntry ? lastEntry.timestamp : null;
  const minutesSinceUpdate = lastUpdate ? Math.floor((now - lastUpdate) / 60000) : null;
  const isStale = !lastUpdate || minutesSinceUpdate > STALE_THRESHOLD_MINUTES;

  const currentActivity = lastFrame ? lastFrame.payload.activity ?? null : null;

  let location = { inside_safe_zone: null, zone_id: null, zone_name: null, lat: null, lng: null };
  if (lastGeofence) {
    const { lat, lng, inside_safe_zone: insideSafeZone } = lastGeofence.payload;
    const zone = resolveZone(lat, lng, zones);
    location = {
      inside_safe_zone: insideSafeZone ?? null,
      zone_id: zone ? zone.id : null,
      zone_name: zone ? zone.name : null,
      lat: lat ?? null,
      lng: lng ?? null,
    };
  }

  const quizTotal = todayQuizQuestions.length;
  const quizCorrect = todayQuizQuestions.filter((q) => q.attempts.some((a) => a.correct)).length;

  return {
    patient: { id: patient.id, name: patient.name },
    last_update: lastUpdate ? lastUpdate.toISOString() : null,
    is_stale: isStale,
    minutes_since_update: minutesSinceUpdate,
    current_activity: currentActivity,
    location,
    needs_attention_count: needsAttentionCount,
    today: { entry_count: todayEntryCount, quiz_correct: quizCorrect, quiz_total: quizTotal },
  };
}

module.exports = { getPatientStatus, resolveZone, STALE_THRESHOLD_MINUTES };
