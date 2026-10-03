const prisma = require('../config/prisma');
const { ensureTag, newCode, caregiverView, publicView } = require('../services/tagService');

// ---- caregiver ----------------------------------------------------------------------------

async function getTag(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });
  const patient = await ensureTag(id);
  if (!patient) return res.status(404).json({ error: 'Patient not found' });
  res.json(await caregiverView(req, patient));
}

async function updateTag(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });
  const { note, home_label, show_home, contacts } = req.body || {};

  if (contacts !== undefined) {
    if (!Array.isArray(contacts) || contacts.length > 5) {
      return res.status(400).json({ error: 'contacts must be a list of at most 5' });
    }
    for (const c of contacts) {
      if (!c || typeof c.name !== 'string' || !c.name.trim() || typeof c.phone !== 'string' || !c.phone.trim()) {
        return res.status(400).json({ error: 'each contact needs a name and a phone' });
      }
    }
  }

  await ensureTag(id);
  await prisma.$transaction(async (tx) => {
    await tx.patient.update({
      where: { id },
      data: {
        ...(note !== undefined && { tagNote: String(note).slice(0, 400) || null }),
        ...(home_label !== undefined && { homeLabel: String(home_label).slice(0, 80) || null }),
        ...(show_home !== undefined && { tagShowHome: Boolean(show_home) }),
      },
    });
    if (contacts !== undefined) {
      await tx.emergencyContact.deleteMany({ where: { patientId: id } });
      await tx.emergencyContact.createMany({
        data: contacts.map((c, i) => ({
          patientId: id,
          name: c.name.trim().slice(0, 60),
          relation: c.relation ? String(c.relation).trim().slice(0, 40) : null,
          phone: c.phone.trim().slice(0, 30),
          sortOrder: i,
        })),
      });
    }
  });
  res.json(await caregiverView(req, await ensureTag(id)));
}

/** New code for a lost sticker: the old link stops working immediately. */
async function rotateTag(req, res) {
  const { id } = req.params;
  if (req.user.patient_id !== id) return res.status(403).json({ error: 'Forbidden for this patient' });
  await prisma.patient.update({ where: { id }, data: { tagCode: newCode() } });
  res.json(await caregiverView(req, await ensureTag(id)));
}

// ---- public (no auth: whoever taps the sticker) -------------------------------------------

// Very small in-memory throttle: a tag page can't be used to spam the family with alerts.
const recent = new Map();
function throttled(key, ms) {
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last < ms) return true;
  recent.set(key, now);
  return false;
}

async function patientByCode(code) {
  if (!/^[a-z0-9]{4,16}$/.test(code || '')) return null;
  return prisma.patient.findUnique({
    where: { tagCode: code },
    include: { emergencyContacts: { orderBy: { sortOrder: 'asc' } } },
  });
}

async function getPublicTag(req, res) {
  const patient = await patientByCode(req.params.code);
  if (!patient) return res.status(404).json({ error: 'This tag is no longer active.' });

  // The scan itself is the alert: someone is with them right now. One per tag every 10 minutes.
  if (!throttled(`scan:${patient.id}`, 10 * 60 * 1000)) {
    await prisma.logEntry.create({
      data: {
        patientId: patient.id,
        entryType: 'sighting',
        payload: { kind: 'scan', user_agent: String(req.get('user-agent') || '').slice(0, 160) },
        requiresAttention: true,
      },
    });
  }
  res.json(await publicView(patient));
}

async function postSighting(req, res) {
  const patient = await patientByCode(req.params.code);
  if (!patient) return res.status(404).json({ error: 'This tag is no longer active.' });
  if (throttled(`loc:${patient.id}:${req.ip}`, 20 * 1000)) return res.status(429).json({ error: 'Already sent — thank you.' });

  const { lat, lng, accuracy, message } = req.body || {};
  const hasFix = typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  await prisma.logEntry.create({
    data: {
      patientId: patient.id,
      entryType: 'sighting',
      payload: {
        kind: 'location',
        ...(hasFix && { lat, lng }),
        ...(typeof accuracy === 'number' && { accuracy: Math.round(accuracy) }),
        ...(message && { message: String(message).slice(0, 300) }),
      },
      requiresAttention: true,
    },
  });
  res.status(201).json({ ok: true });
}

module.exports = { getTag, updateTag, rotateTag, getPublicTag, postSighting };
