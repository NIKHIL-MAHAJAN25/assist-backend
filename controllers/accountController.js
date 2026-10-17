const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { registerDevice } = require('../services/deviceService');

// Self-serve accounts: a caregiver signs up and creates the patient, then hands out short codes —
// to other family members (kind=caregiver) and to the patient's own phone (kind=device).

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L — read aloud over the phone
const TTL_HOURS = { caregiver: 72, device: 24 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function newCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Accept "k7p-4qx", "K7P 4QX", etc.
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sessionFor(user, patient) {
  const token = jwt.sign(
    { sub: user.id, role: user.role, patient_id: user.patientId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  return {
    token,
    user: { id: user.id, name: user.name, role: user.role, patient_id: user.patientId, patient_name: patient.name },
  };
}

function checkAccount({ name, email, password }) {
  if (!name || !String(name).trim()) return 'Your name is required';
  if (!email || !EMAIL_RE.test(String(email).trim())) return 'A valid email is required';
  if (!password || String(password).length < 8) return 'Password must be at least 8 characters';
  return null;
}

async function emailTaken(email) {
  return !!(await prisma.user.findUnique({ where: { email } }));
}

async function findLiveInvite(code, kind) {
  const invite = await prisma.invite.findUnique({
    where: { code: normalizeCode(code) },
    include: { patient: true, creator: true },
  });
  if (!invite || invite.kind !== kind) return { error: 'That code is not valid', status: 404 };
  if (invite.usedAt) return { error: 'That code has already been used', status: 410 };
  if (invite.expiresAt < new Date()) return { error: 'That code has expired — ask for a new one', status: 410 };
  return { invite };
}

// POST /api/auth/signup — new caregiver + the person they look after.
async function signup(req, res) {
  const { name, email, password, patient_name, patient_dob, home_label } = req.body || {};
  const problem = checkAccount({ name, email, password });
  if (problem) return res.status(400).json({ error: problem });
  if (!patient_name || !String(patient_name).trim()) return res.status(400).json({ error: "The name of the person you care for is required" });

  const cleanEmail = String(email).trim().toLowerCase();
  if (await emailTaken(cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists' });

  const dob = patient_dob ? new Date(patient_dob) : null;
  if (dob && Number.isNaN(dob.getTime())) return res.status(400).json({ error: 'Date of birth is not a valid date' });

  const passwordHash = await bcrypt.hash(String(password), 10);
  const { user, patient } = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.create({
      data: {
        name: String(patient_name).trim(),
        dob: dob || new Date('1950-01-01'),
        homeLabel: home_label ? String(home_label).trim() : null,
      },
    });
    const user = await tx.user.create({
      data: { name: String(name).trim(), email: cleanEmail, passwordHash, role: 'family_caregiver', patientId: patient.id },
    });
    return { user, patient };
  });

  res.status(201).json(sessionFor(user, patient));
}

// GET /api/invites/:code — public preview for the join screen ("Priya invited you to help look after Margaret").
async function previewInvite(req, res) {
  const { invite, error, status } = await findLiveInvite(req.params.code, req.query.kind || 'caregiver');
  if (error) return res.status(status).json({ error });
  res.json({
    kind: invite.kind,
    patient_first_name: invite.patient.name.split(' ')[0],
    invited_by: invite.creator.name.split(' ')[0],
    expires_at: invite.expiresAt,
  });
}

// POST /api/auth/join — accept a caregiver invite.
async function join(req, res) {
  const { code, name, email, password } = req.body || {};
  const problem = checkAccount({ name, email, password });
  if (problem) return res.status(400).json({ error: problem });

  const { invite, error, status } = await findLiveInvite(code, 'caregiver');
  if (error) return res.status(status).json({ error });

  const cleanEmail = String(email).trim().toLowerCase();
  if (await emailTaken(cleanEmail)) return res.status(409).json({ error: 'An account with that email already exists' });

  const passwordHash = await bcrypt.hash(String(password), 10);
  const user = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invite.updateMany({
      where: { id: invite.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) throw Object.assign(new Error('used'), { code: 'INVITE_USED' });
    const user = await tx.user.create({
      data: { name: String(name).trim(), email: cleanEmail, passwordHash, role: 'family_caregiver', patientId: invite.patientId },
    });
    await tx.invite.update({ where: { id: invite.id }, data: { usedBy: user.id } });
    return user;
  }).catch((e) => (e.code === 'INVITE_USED' ? null : Promise.reject(e)));
  if (!user) return res.status(410).json({ error: 'That code has already been used' });

  res.status(201).json(sessionFor(user, invite.patient));
}

// POST /api/devices/pair — the patient's phone trades a device code for its api_key.
async function pairDevice(req, res) {
  const { code, identifier, device_type = 'esp32cam' } = req.body || {};
  if (!code || !identifier) return res.status(400).json({ error: 'code and identifier are required' });
  if (!['esp32cam', 'watch'].includes(device_type)) return res.status(400).json({ error: 'device_type must be esp32cam or watch' });

  const { invite, error, status } = await findLiveInvite(code, 'device');
  if (error) return res.status(status).json({ error });

  const claimed = await prisma.invite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return res.status(410).json({ error: 'That code has already been used' });

  const { deviceId, apiKey } = await registerDevice({ patientId: invite.patientId, deviceType: device_type, identifier: String(identifier).trim() });
  await prisma.invite.update({ where: { id: invite.id }, data: { usedBy: deviceId } });

  res.status(201).json({ device_id: deviceId, api_key: apiKey, patient_id: invite.patientId, patient_name: invite.patient.name });
}

function samePatient(req, res) {
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

function publicInvite(i) {
  return { code: i.code, kind: i.kind, created_at: i.createdAt, expires_at: i.expiresAt, created_by: i.creator?.name ?? null };
}

// POST /api/patients/:id/invites { kind }
async function createInvite(req, res) {
  if (!samePatient(req, res)) return;
  const kind = (req.body && req.body.kind) || 'caregiver';
  if (!['caregiver', 'device'].includes(kind)) return res.status(400).json({ error: 'kind must be caregiver or device' });

  // One live code per kind at a time: a fresh one replaces any unused older one.
  await prisma.invite.deleteMany({ where: { patientId: req.params.id, kind, usedAt: null } });

  let invite;
  for (let attempt = 0; attempt < 5 && !invite; attempt++) {
    try {
      invite = await prisma.invite.create({
        data: {
          code: newCode(),
          patientId: req.params.id,
          kind,
          createdBy: req.user.sub,
          expiresAt: new Date(Date.now() + TTL_HOURS[kind] * 3600 * 1000),
        },
        include: { creator: true },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e; // code collision — try another
    }
  }
  res.status(201).json(publicInvite(invite));
}

// GET /api/patients/:id/invites — codes still waiting to be used.
async function listInvites(req, res) {
  if (!samePatient(req, res)) return;
  const invites = await prisma.invite.findMany({
    where: { patientId: req.params.id, usedAt: null, expiresAt: { gt: new Date() } },
    include: { creator: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invites.map(publicInvite));
}

// DELETE /api/patients/:id/invites/:code
async function revokeInvite(req, res) {
  if (!samePatient(req, res)) return;
  await prisma.invite.deleteMany({ where: { patientId: req.params.id, code: normalizeCode(req.params.code), usedAt: null } });
  res.status(204).send();
}

// GET /api/patients/:id/caregivers — the family circle.
async function listCaregivers(req, res) {
  if (!samePatient(req, res)) return;
  const users = await prisma.user.findMany({
    where: { patientId: req.params.id, role: 'family_caregiver' },
    orderBy: { createdAt: 'asc' },
  });
  res.json(users.map((u) => ({ id: u.id, name: u.name, email: u.email, joined_at: u.createdAt, is_you: u.id === req.user.sub })));
}

module.exports = {
  signup, join, previewInvite, pairDevice, createInvite, listInvites, revokeInvite, listCaregivers, normalizeCode, newCode,
};
