const prisma = require('../config/prisma');
const { TYPES } = require('./commandTypes');

// Fall check (#15): when the camera reports a fall (or the watch an emergency), the system asks the
// patient on their phone "are you okay?". An "I'm okay" calms the family alert; "I need help" or no
// answer within ANSWER_WINDOW escalates: an act-now family event + the phone rings loudly.

const ANSWER_WINDOW_MS = 2 * 60000;
const OK = /\b(ok|okay|fine|alright|all right|yes|good)\b/i;

async function start(patientId, { logEntryId = null, reason = 'The camera saw a possible fall' } = {}) {
  // One check at a time: a fall seen on several frames shouldn't ask five times.
  const open = await prisma.deviceCommand.findFirst({
    where: { patientId, type: 'ask', createdAt: { gte: new Date(Date.now() - 10 * 60000) } },
    orderBy: { createdAt: 'desc' },
  });
  if (open?.payload?.fall_check) return null;

  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true } });
  const first = (patient?.name || 'there').split(' ')[0];
  const payload = {
    ...TYPES.ask.clean({ question: `${first}, are you okay?`, quick: ["I'm okay", 'I need help'] }),
    fall_check: true,
    reason,
    log_entry_id: logEntryId,
  };
  const [cmd] = await prisma.$transaction([
    prisma.deviceCommand.create({
      data: { patientId, type: 'ask', payload, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) },
    }),
    prisma.familyEvent.create({
      data: { patientId, kind: 'fall_check', severity: 'act', title: `Possible fall — checking with ${first}`, body: `${reason}. Her phone is asking "are you okay?"; you'll hear back within 2 minutes.`, refId: logEntryId },
    }),
  ]);
  return cmd;
}

/** Called when the patient answers a fall-check question. */
async function answered(cmd, reply) {
  const patient = await prisma.patient.findUnique({ where: { id: cmd.patientId }, select: { name: true } });
  const first = (patient?.name || 'They').split(' ')[0];
  if (OK.test(reply) && !/help/i.test(reply)) {
    await prisma.familyEvent.create({
      data: { patientId: cmd.patientId, kind: 'fall_ok', severity: 'info', title: `${first} says she's okay`, body: `After the possible fall she answered “${reply}”. A call later is still a good idea.`, refId: cmd.id },
    });
  } else {
    await escalate(cmd, `${first} answered “${reply}”`);
  }
}

async function escalate(cmd, why) {
  if (cmd.payload?.escalated) return;
  const patient = await prisma.patient.findUnique({ where: { id: cmd.patientId }, select: { name: true } });
  const first = (patient?.name || 'They').split(' ')[0];
  await prisma.$transaction([
    prisma.deviceCommand.update({ where: { id: cmd.id }, data: { payload: { ...cmd.payload, escalated: true } } }),
    prisma.familyEvent.create({
      data: { patientId: cmd.patientId, kind: 'fall_escalated', severity: 'act', title: `⚠ Possible fall — ${first} needs you`, body: `${why}. Her phone is ringing. Call her now.`, refId: cmd.id },
    }),
    prisma.deviceCommand.create({
      data: { patientId: cmd.patientId, type: 'ring', payload: {}, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) },
    }),
  ]);
}

/** Scheduler: escalate fall checks nobody answered in time. */
async function sweep() {
  const pending = await prisma.deviceCommand.findMany({
    where: { type: 'ask', status: { in: ['pending', 'delivered', 'expired'] }, createdAt: { lt: new Date(Date.now() - ANSWER_WINDOW_MS), gte: new Date(Date.now() - 30 * 60000) } },
  });
  for (const c of pending.filter((x) => x.payload?.fall_check && !x.payload.escalated)) {
    await escalate(c, 'No answer to “are you okay?” after 2 minutes').catch((e) => console.error('[fall]', e.message));
  }
}

module.exports = { start, answered, sweep, ANSWER_WINDOW_MS };
