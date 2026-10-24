const prisma = require('../config/prisma');

// Text messages to the emergency contacts, sent by the patient's own phone (its SIM, SEND_SMS
// permission) — no SMS gateway. The backend queues an `sms` command for the phone; the phone texts
// every number in it and acks. Contacts are the ones on the emergency tag page.
//
// Each reason texts at most once per SMS_EVERY_MS: the watch reports every few seconds and the
// location every minute, and a family member should get one text per event, not a stream.

const SMS_EVERY_MS = 15 * 60000;

const REASONS = {
  left_safe_area: 'left the safe places',
  heart_spike: 'heart rate spike',
  sos: 'pressed Hold for help',
  fall: 'possible fall, no answer',
  tag_scan: 'emergency tag tapped',
  test: 'test',
};

const mapLink = (lat, lng) => `https://maps.google.com/?q=${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;

/** Where the phone last was, as a map link, or null. */
async function lastPlace(patientId) {
  const ping = await prisma.logEntry.findFirst({ where: { patientId, entryType: 'geofence' }, orderBy: { timestamp: 'desc' }, select: { payload: true } });
  const p = ping?.payload;
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? mapLink(p.lat, p.lng) : null;
}

/**
 * Queue a text to every emergency contact. `force` skips the once-per-15-minutes limit (demo button).
 * Returns { queued, command_id, to } or { queued: false, why }.
 */
async function alert(patientId, reason, text, { force = false, withPlace = true } = {}) {
  if (!REASONS[reason]) throw new Error(`unknown sms reason ${reason}`);
  const contacts = await prisma.emergencyContact.findMany({ where: { patientId }, orderBy: { sortOrder: 'asc' }, select: { phone: true } });
  if (!contacts.length) return { queued: false, why: 'no emergency contacts' };
  if (!force) {
    const recent = await prisma.deviceCommand.findFirst({
      where: { patientId, type: 'sms', createdAt: { gte: new Date(Date.now() - SMS_EVERY_MS) }, payload: { path: ['reason'], equals: reason } },
      select: { id: true },
    });
    if (recent) return { queued: false, why: 'already texted about this in the last 15 minutes' };
  }
  const place = withPlace ? await lastPlace(patientId) : null;
  const body = `Assist: ${text}${place ? ` Last location: ${place}` : ''}`.slice(0, 450);
  const cmd = await prisma.deviceCommand.create({
    data: {
      patientId,
      type: 'sms',
      payload: { to: contacts.map((c) => c.phone), text: body, reason },
      createdBy: 'system',
      senderName: 'Assist',
      expiresAt: new Date(Date.now() + 30 * 60000),
    },
  });
  console.log(`[sms] ${reason} → ${contacts.length} contact(s)`);
  return { queued: true, command_id: cmd.id, to: contacts.length, text: body };
}

/** Never throws: a text that can't be queued must not break the alert that caused it. */
const quietly = (...args) => alert(...args).catch((e) => console.error('[sms]', e.message));

module.exports = { alert, quietly, REASONS, SMS_EVERY_MS };
