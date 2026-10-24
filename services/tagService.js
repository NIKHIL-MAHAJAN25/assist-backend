const crypto = require('crypto');
const prisma = require('../config/prisma');

// Short, unambiguous code for the sticker URL (no 0/O/1/l/I), so it fits even a small NTAG213.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const DEFAULT_NOTE =
  'I have memory loss and may be confused or lost. Please stay with me, keep me calm, and call my family.';

/** Makes sure the patient has a tag code; returns the patient with contacts. */
async function ensureTag(patientId) {
  let patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: { emergencyContacts: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!patient) return null;
  if (!patient.tagCode) {
    for (let i = 0; i < 5; i += 1) {
      try {
        patient = await prisma.patient.update({
          where: { id: patientId },
          data: { tagCode: newCode(), tagNote: patient.tagNote ?? DEFAULT_NOTE },
          include: { emergencyContacts: { orderBy: { sortOrder: 'asc' } } },
        });
        break;
      } catch (err) {
        if (err.code !== 'P2002') throw err; // retry only on a code collision
      }
    }
  }
  return patient;
}

async function homeZone(patientId) {
  const zones = await prisma.geofenceZone.findMany({ where: { patientId }, orderBy: { createdAt: 'asc' } });
  return zones.find((z) => z.name.trim().toLowerCase() === 'home') || null;
}

function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** What a caregiver sees and edits. */
async function caregiverView(req, patient) {
  const home = await homeZone(patient.id);
  return {
    code: patient.tagCode,
    url: `${publicBase(req)}/t/${patient.tagCode}`,
    note: patient.tagNote,
    home_label: patient.homeLabel,
    show_home: patient.tagShowHome,
    has_home_zone: Boolean(home),
    contacts: patient.emergencyContacts.map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
  };
}

/** What a stranger who taps the sticker sees: first name only, no surname, no date of birth. */
async function publicView(patient) {
  const home = patient.tagShowHome ? await homeZone(patient.id) : null;
  return {
    first_name: patient.name.trim().split(/\s+/)[0],
    note: patient.tagNote || DEFAULT_NOTE,
    contacts: patient.emergencyContacts.map((c) => ({ name: c.name, relation: c.relation, phone: c.phone })),
    home: patient.tagShowHome
      ? { label: patient.homeLabel || null, lat: home ? home.centerLat : null, lng: home ? home.centerLng : null }
      : null,
  };
}

module.exports = { ensureTag, newCode, caregiverView, publicView, publicBase, DEFAULT_NOTE };
