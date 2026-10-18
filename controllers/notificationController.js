const prisma = require('../config/prisma');

// GET /api/patients/:id/notifications?since=ISO — one feed for the family: alerts, Margaret's answers,
// actions that didn't reach her phone, and notes from the family circle. The website and the family
// app poll it and raise browser / phone notifications for anything new (no FCM project needed).

function ownPatient(req, res) {
  if (req.user.patient_id !== req.params.id) {
    res.status(403).json({ error: 'Forbidden for this patient' });
    return false;
  }
  return true;
}

function alertText(e, first) {
  const p = e.payload || {};
  switch (e.entryType) {
    case 'geofence':
      return { title: `${first} left the safe places`, body: p.demo ? 'Simulated walk (demo)' : 'Phone location is outside every safe place.' };
    case 'frame':
      return { title: `Camera: ${p.activity || 'something needs a look'}`, body: p.person_state && p.person_state !== 'not visible' ? p.person_state : 'From the home camera.' };
    case 'heartrate':
      return { title: `Watch alert for ${first}`, body: `${p.scenario || 'Unusual reading'} · heart rate ${p.heart_rate ?? '?'}` };
    case 'sighting':
      return { title: `Someone tapped ${first}'s emergency tag`, body: p.kind === 'location' ? 'They shared where they are.' : 'Open the app to see more.' };
    default:
      return { title: `Alert for ${first}`, body: '' };
  }
}

async function list(req, res) {
  if (!ownPatient(req, res)) return;
  const pid = req.params.id;
  const since = req.query.since && !Number.isNaN(new Date(req.query.since).getTime()) ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
  const patient = await prisma.patient.findUnique({ where: { id: pid } });
  const first = (patient?.name || 'They').split(' ')[0];

  const [alerts, answered, failed, notes] = await Promise.all([
    prisma.logEntry.findMany({ where: { patientId: pid, requiresAttention: true, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.deviceCommand.findMany({ where: { patientId: pid, type: 'ask', status: 'done', doneAt: { gte: since } }, orderBy: { doneAt: 'desc' }, take: 20 }),
    prisma.deviceCommand.findMany({ where: { patientId: pid, status: { in: ['failed', 'expired'] }, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.familyBroadcast.findMany({ where: { patientId: pid, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const items = [
    ...alerts.map((e) => ({ id: `alert:${e.id}`, kind: 'alert', severity: 'act', at: e.createdAt, acknowledged: !!e.acknowledgedAt, log_entry_id: e.id, ...alertText(e, first) })),
    ...answered.filter((c) => c.payload?.reply).map((c) => ({
      id: `reply:${c.id}`, kind: 'reply', severity: 'info', at: c.doneAt,
      title: `${first} answered: “${c.payload.reply}”`, body: `You asked: ${c.payload.question}`,
    })),
    ...failed.map((c) => ({
      id: `failed:${c.id}`, kind: 'failed', severity: 'watch', at: c.createdAt,
      title: c.status === 'expired' ? `${first}'s phone didn't pick up an action` : `An action didn't work on ${first}'s phone`,
      body: c.error || `${c.type} from ${c.senderName}`,
    })),
    ...notes.map((n) => ({
      id: `note:${n.id}`, kind: 'note', severity: 'info', at: n.createdAt, mine: n.fromUserId === req.user.sub,
      title: `${n.senderName}: ${n.text.length > 60 ? `${n.text.slice(0, 57)}…` : n.text}`, body: n.text,
    })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 50);

  res.json({ items, now: new Date() });
}

// POST /api/patients/:id/broadcasts { text } — "Tell the family"
async function broadcast(req, res) {
  if (!ownPatient(req, res)) return;
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  const [n, members] = await Promise.all([
    prisma.familyBroadcast.create({
      data: { patientId: req.params.id, fromUserId: req.user.sub, senderName: (user?.name || 'Family').split(' ')[0], text },
    }),
    prisma.user.count({ where: { patientId: req.params.id, role: 'family_caregiver' } }),
  ]);
  res.status(201).json({ id: n.id, text: n.text, from: n.senderName, created_at: n.createdAt, family_members: members });
}

module.exports = { list, broadcast };
