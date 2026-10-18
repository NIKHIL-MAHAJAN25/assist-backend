const prisma = require('../config/prisma');
const journal = require('./journalService');
const { enqueueStory, waitFor } = require('./jobQueue');
const voice = require('./voiceService');

// Bedtime "your day" story (#18): a few warm sentences about the patient's own day, written TO them
// ("Today you…") from the journal by a helper, sent to their phone to be read aloud and kept on screen.
// Memory support: something gentle to hold on to at the end of the day.

function storyPrompt(first, journalText) {
  return `Write a short bedtime story for ${first}, who lives with memory loss, about ${first}'s own day,
spoken directly to ${first} ("Today you…"). 4 to 6 short, simple, warm sentences. Mention the nice parts of
the day from the journal below — meals, walks, messages from family, things they did. Leave out alerts,
falls, worries, times and anything frightening. Never invent things that are not in the journal; if very little
happened, say it was a quiet, restful day. End with a gentle goodnight and that their family loves them.

Reply with ONLY the story text.

Journal:
${journalText}`;
}

/** Writes today's story and sends it to the phone. Returns { text, provider, command_id }. */
async function sendStory(patientId, { senderName = 'Assist', createdBy = 'system' } = {}) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { name: true } });
  const first = (patient?.name || 'there').split(' ')[0];
  await journal.writeDay(patientId);
  const text = (await journal.readDay(patientId)).trim();
  const job = await enqueueStory({ patientId, prompt: storyPrompt(first, text || '(nothing recorded today)') });
  const done = await waitFor(job.id, 90000);
  if (!done || done.status !== 'done') throw new Error('No helper could write the story just now');
  const story = done.result.text.replace(/^["“]|["”]$/g, '').trim().slice(0, 1500);
  const [cmd] = await prisma.$transaction([
    prisma.deviceCommand.create({
      data: { patientId, type: 'story', payload: { text: story, title: 'Your day', ...(voice.wantsVoice('story') && { voice_pending: true }) }, createdBy, senderName, expiresAt: new Date(Date.now() + 30 * 60000) },
    }),
    prisma.familyEvent.create({
      data: { patientId, kind: 'story', severity: 'info', title: `Bedtime story sent to ${first}`, body: story.length > 160 ? `${story.slice(0, 157)}…` : story },
    }),
  ]);
  voice.prepareCommand(cmd);
  return { text: story, provider: done.result.provider, command_id: cmd.id };
}

/** Scheduler: send the story at each patient's bedtime (once a day). */
async function sweep() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const patients = await prisma.patient.findMany({ where: { bedtimeStoryAt: { not: null } }, select: { id: true, bedtimeStoryAt: true } });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const p of patients) {
    // Within 10 minutes after bedtime, once a day, and only for patients with a paired phone.
    const [h, m] = p.bedtimeStoryAt.split(':').map(Number);
    const at = new Date();
    at.setHours(h, m, 0, 0);
    if (now < at || now - at > 10 * 60000) continue;
    const [sent, phone] = await Promise.all([
      prisma.familyEvent.findFirst({ where: { patientId: p.id, kind: 'story', createdAt: { gte: today } } }),
      prisma.device.findFirst({ where: { patientId: p.id, NOT: { identifier: { startsWith: 'demo:' } } } }),
    ]);
    if (sent || !phone) continue;
    sendStory(p.id).catch((e) => console.error('[story]', e.message));
    void hhmm;
  }
}

module.exports = { sendStory, sweep, storyPrompt };
