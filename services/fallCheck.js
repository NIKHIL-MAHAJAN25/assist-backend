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
  const voice = require('./voiceService');
  const [cmd] = await prisma.$transaction([
    prisma.deviceCommand.create({
      data: { patientId, type: 'ask', payload: voice.wantsVoice('ask') ? { ...payload, voice_pending: true } : payload, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) },
    }),
    prisma.familyEvent.create({
      data: { patientId, kind: 'fall_check', severity: 'act', title: `Possible fall — checking with ${first}`, body: `${reason}. ${first}'s phone is asking "are you okay?"; you'll hear back within 2 minutes.`, refId: logEntryId },
    }),
  ]);
  voice.prepareCommand(cmd); // pre-generated at startup, so this is a cache hit

  // Ask on the watch too when one is paired; the first answer wins (see answered()).
  const hasWatch = await prisma.device.findFirst({ where: { patientId, deviceType: 'watch', NOT: { identifier: 'demo:watch-history' } }, select: { id: true } });
  if (hasWatch) {
    const onWatch = await prisma.deviceCommand.create({
      data: { patientId, type: 'ask', target: 'watch', payload: { ...payload, group: cmd.id }, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) },
    });
    require('./watchService').simulateDelivery(onWatch);
  }
  return cmd;
}

/** Called when the patient answers a fall-check question. */
async function answered(cmd, reply) {
  // The same question on the other device is closed, so it neither waits nor escalates.
  const groupId = cmd.payload?.group || cmd.id;
  const siblings = await prisma.deviceCommand.findMany({ where: { patientId: cmd.patientId, type: 'ask', status: { not: 'done' }, createdAt: { gte: new Date(Date.now() - 15 * 60000) }, NOT: { id: cmd.id } } });
  for (const s of siblings.filter((s) => s.id === groupId || s.payload?.group === groupId)) {
    await prisma.deviceCommand.update({ where: { id: s.id }, data: { status: 'done', doneAt: new Date(), payload: { ...s.payload, superseded_by: cmd.id, escalated: true } } });
    // The watch takes a question off the wrist when told it was answered elsewhere.
    if (s.target === 'watch') {
      await prisma.deviceCommand.create({ data: { patientId: s.patientId, type: 'dismiss', target: 'watch', payload: { ref: s.id }, createdBy: 'system', senderName: 'Assist', expiresAt: new Date(Date.now() + 10 * 60000) } });
    }
  }
  const patient = await prisma.patient.findUnique({ where: { id: cmd.patientId }, select: { name: true } });
  const first = (patient?.name || 'They').split(' ')[0];
  if (OK.test(reply) && !/help/i.test(reply)) {
    await prisma.familyEvent.create({
      data: { patientId: cmd.patientId, kind: 'fall_ok', severity: 'info', title: `${first} says they're okay${cmd.payload?.via === 'watch' || cmd.target === 'watch' ? ' (on the watch)' : ''}`, body: `After the possible fall ${first} answered “${reply}”. A call later is still a good idea.`, refId: cmd.id },
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
      data: { patientId: cmd.patientId, kind: 'fall_escalated', severity: 'act', title: `⚠ Possible fall — ${first} needs you`, body: `${why}. ${first}'s phone is ringing. Call now.`, refId: cmd.id },
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
  // The watch's copy of a question never escalates on its own; the phone's row stands for the group.
  for (const c of pending.filter((x) => x.payload?.fall_check && !x.payload.escalated && x.target !== 'watch')) {
    await escalate(c, 'No answer to “are you okay?” after 2 minutes').catch((e) => console.error('[fall]', e.message));
  }
}

module.exports = { start, answered, sweep, ANSWER_WINDOW_MS };
