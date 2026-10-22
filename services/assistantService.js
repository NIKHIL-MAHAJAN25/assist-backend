const prisma = require('../config/prisma');
const journal = require('./journalService');
const { getPatientStatus } = require('./patientStatusService');
const { describe } = require('./commandTypes');
const { recentObjects } = require('./insightsService');
const { buildEvidence, evidenceText } = require('./evidenceService');

// The family Assistant: a grounded agent that answers from what the system knows and PROPOSES
// actions. It never acts on the patient by itself — anything that reaches the patient (speaking on
// their phone) comes back as a proposal the family member confirms in the UI.
//
// Actions are a closed registry, so new capabilities are added here (and rendered in the dashboard's
// Assistant page) without changing the queue or the providers.

const ACTIONS = {
  speak: {
    describe: 'Say something aloud on the patient\'s phone (text-to-speech) and show it on their screen. ' +
      'Use for reassurance, reminders, or a message the family asks to send. Write it the way you would speak ' +
      'to someone with memory loss: short, warm, one idea, their first name, no questions that need memory.',
    shape: '{"type":"speak","text":"…"}',
    validate: (a) => (typeof a.text === 'string' && a.text.trim() ? { type: 'speak', text: a.text.trim().slice(0, 280) } : null),
  },
  ask: {
    describe: 'Ask the patient a simple question on their phone (spoken aloud, with tap-to-answer buttons); ' +
      'their answer comes back here. Yes/no or one-word questions work best.',
    shape: '{"type":"ask","question":"…","quick":["Yes","No","Not yet"]}',
    validate: (a) => (typeof a.question === 'string' && a.question.trim()
      ? { type: 'ask', question: a.question.trim().slice(0, 200), quick: Array.isArray(a.quick) ? a.quick.slice(0, 3).map((q) => String(q).slice(0, 24)) : ['Yes', 'No', 'Not yet'] }
      : null),
  },
  reminder: {
    describe: 'Set a one-off reminder on the patient\'s phone at a time today (spoken and shown).',
    shape: '{"type":"reminder","text":"Drink a glass of water","at":"16:00"}',
    validate: (a) => (typeof a.text === 'string' && /^\d{1,2}:\d{2}$/.test(String(a.at || '')) ? { type: 'reminder', text: a.text.trim().slice(0, 140), at: a.at } : null),
  },
  capture: {
    describe: 'Take a fresh photo from the home camera right now and describe it.',
    shape: '{"type":"capture"}',
    validate: () => ({ type: 'capture' }),
  },
  ring: {
    describe: 'Make the patient\'s phone ring loudly for 20 seconds (when they can\'t find it or aren\'t answering).',
    shape: '{"type":"ring"}',
    validate: () => ({ type: 'ring' }),
  },
  guide_home: {
    describe: 'When they are outside the safe places: tell them gently to head home, open the way-home arrow on ' +
      'their phone, and send their location more often for 15 minutes.',
    shape: '{"type":"guide_home"}',
    validate: () => ({ type: 'guide_home' }),
  },
  calm: {
    describe: 'Calm-down: a slow, reassuring spoken breathing moment on their phone (plus the family\'s latest voice note).',
    shape: '{"type":"calm"}',
    validate: () => ({ type: 'calm' }),
  },
  quiz: {
    describe: 'Send today\'s short memory quiz to their phone now.',
    shape: '{"type":"quiz"}',
    validate: () => ({ type: 'quiz' }),
  },
  rule: {
    describe: 'Set up a "tell me when…" watch the system checks on its own and notifies the family about. ' +
      'Use for requests like "tell me when she gets home", "let me know if she hasn\'t eaten by 2", "warn me if she\'s still in bed at 9". ' +
      'Kinds:\n' + require('./ruleEngine').describeKinds() + '\n  repeat: "once" (default) or "daily".',
    shape: '{"type":"rule","kind":"arrives_home","params":{},"repeat":"once"}',
    validate: (a) => {
      const c = require('./ruleEngine').cleanRule({ kind: a.kind, params: a.params || {}, repeat: a.repeat }, 'them');
      return c ? { type: 'rule', kind: c.kind, params: c.params, repeat: c.repeat } : null;
    },
  },
  story: {
    describe: 'Write and send a short, warm "your day" story to the patient\'s phone now (read aloud), e.g. at bedtime.',
    shape: '{"type":"story"}',
    validate: () => ({ type: 'story' }),
  },
  broadcast: {
    describe: 'Tell the whole family circle something (e.g. "She\'s fine, I just spoke to her"). Everyone gets it as a notification.',
    shape: '{"type":"broadcast","text":"…"}',
    validate: (a) => (typeof a.text === 'string' && a.text.trim() ? { type: 'broadcast', text: a.text.trim().slice(0, 500) } : null),
  },
  find: {
    describe: 'Show where the camera last saw an object ("where did she leave her glasses?"), with the photo. ' +
      'Use the plain object word, e.g. "glasses", "keys", "handbag". Answer from the "Objects the camera noticed" list.',
    shape: '{"type":"find","object":"glasses"}',
    validate: (a) => (typeof a.object === 'string' && a.object.trim() ? { type: 'find', object: a.object.trim().slice(0, 40) } : null),
  },
  replay: {
    describe: 'Replay their walk on a map, step by step (today\'s path, or their latest time outside the safe places).',
    shape: '{"type":"replay","window":"today|last_outing"}',
    validate: (a) => ({ type: 'replay', window: a.window === 'today' ? 'today' : 'last_outing' }),
  },
  album: {
    describe: 'Reminiscence: show the family photo album on their phone as a slow slideshow, each photo read aloud. ' +
      'Good for calming, for a lonely afternoon, or before a visit.',
    shape: '{"type":"album"}',
    validate: () => ({ type: 'album' }),
  },
  report: {
    describe: 'Open the doctor\'s report: 1, 2 or 4 weeks of routine, meals, rest, wandering, falls and the quiz trend, printable.',
    shape: '{"type":"report","days":14}',
    validate: (a) => ({ type: 'report', days: [7, 14, 28].includes(Number(a.days)) ? Number(a.days) : 14 }),
  },
  map: {
    describe: 'Show where they are now on a map, with the safe places.',
    shape: '{"type":"map"}',
    validate: () => ({ type: 'map' }),
  },
  photo: {
    describe: 'Show the latest photo from the home camera.',
    shape: '{"type":"photo"}',
    validate: () => ({ type: 'photo' }),
  },
  summary: {
    describe: 'Show a written summary of a period.',
    shape: '{"type":"summary","range":"today|morning|week"}',
    validate: (a) => ({ type: 'summary', range: ['today', 'morning', 'week'].includes(a.range) ? a.range : 'today' }),
  },
};

const ago = (d) => {
  if (!d) return 'never';
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

/** Everything the agent may know, as plain text. Also returns the list of sources for the UI. */
async function gatherContext(patient) {
  const [status, journalText, zones, commands, watching, objects, albumCount, evidence] = await Promise.all([
    getPatientStatus(patient),
    journal.writeDay(patient.id).then(() => journal.readDay(patient.id)),
    prisma.geofenceZone.findMany({ where: { patientId: patient.id }, select: { name: true } }),
    prisma.deviceCommand.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
    prisma.watchRule.findMany({ where: { patientId: patient.id, active: true }, select: { label: true } }),
    recentObjects(patient.id).catch(() => []),
    prisma.memory.count({ where: { patientId: patient.id } }),
    buildEvidence(patient.id).catch(() => []),
  ]);
  const loc = status.location;
  const where = loc.inside_safe_zone === false
    ? 'OUTSIDE all safe places'
    : loc.zone_name ? `at ${loc.zone_name} (a safe place)` : loc.inside_safe_zone ? 'inside a safe place' : 'unknown';

  const lines = [
    `Now: ${new Date().toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`,
    `Last reading from their devices: ${ago(status.last_update)}${status.is_stale ? ' (STALE — devices quiet for a while)' : ''}`,
    `Phone location: ${where}`,
    `Latest camera activity: ${status.current_activity || 'none today'}`,
    `Unacknowledged alerts: ${status.needs_attention_count}`,
    `Safe places: ${zones.map((z) => z.name).join(', ') || 'none set up'}`,
    `Memory quiz today: ${status.today.quiz_total ? `${status.today.quiz_correct} of ${status.today.quiz_total} right` : 'not taken yet'}`,
    `Family is already watching for: ${watching.length ? watching.map((w) => w.label).join('; ') : 'nothing'}`,
    `Family photo album: ${albumCount ? `${albumCount} photo${albumCount > 1 ? 's' : ''}` : 'empty (add photos on the Memory page)'}`,
    `Recent actions on their phone: ${commands.length ? commands.map((c) => `${describe(c)} (${c.status}, ${ago(c.createdAt)}, by ${c.senderName})`).join('; ') : 'none'}`,
  ];
  return {
    text: `${lines.join('\n')}\n\nObjects the camera noticed (last 3 days, newest sighting of each):\n${objects.length ? objects.join('\n') : '(none)'}` +
      `\n\nToday's journal (oldest first):\n${journalText.trim() || '(empty)'}` +
      `\n\nEvidence you can cite (today, oldest first):\n${evidenceText(evidence)}`,
    sources: ['location', 'camera', 'journal', 'alerts', ...(commands.length ? ['messages'] : []), ...(objects.length ? ['objects'] : [])],
    status,
    evidence,
  };
}

function buildPrompt({ firstName, caregiverName, context, history, message }) {
  const convo = (history || []).slice(-8).map((t) => `${t.role === 'user' ? caregiverName : 'Assistant'}: ${String(t.text).slice(0, 600)}`).join('\n');
  return `You are the Assist family assistant. You help ${caregiverName}, a family member of ${firstName}, who lives
with memory loss and is watched over by a home camera, their phone's location, and reminders. Answer ONLY from
the context below; if it doesn't say, say you don't know. Be brief and warm (1–3 sentences), plain words, no
medical advice. If something looks unsafe, say so plainly and suggest calling them.

Show your evidence: when a sentence relies on a specific item from the "Evidence you can cite" list,
end that sentence with its id in square brackets, e.g. "She had lunch at the table at 1:10 [E4]."
Cite at most 3 ids, only ids that exist in the list, and never cite for general advice.

You can propose actions. The family member must confirm anything that reaches ${firstName}; you never send it
yourself, so phrase it as a suggestion ("I can say this to her phone:"). Propose an action only when it helps.
Available actions:
${Object.entries(ACTIONS).map(([k, a]) => `- ${k}: ${a.describe} Format: ${a.shape}`).join('\n')}

Reply with ONLY one JSON object, no prose around it, no code fences:
{"reply":"…","actions":[ … ]}

=== Context ===
${context}

=== Conversation so far ===
${convo || '(new conversation)'}

${caregiverName}: ${message}`;
}

/** Parse an agent answer from any provider. Falls back to plain text if it isn't JSON. */
function parseAnswer(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const v = JSON.parse(m[0]);
      const actions = (Array.isArray(v.actions) ? v.actions : [])
        .map((a) => (a && ACTIONS[a.type] ? ACTIONS[a.type].validate(a) : null))
        .filter(Boolean)
        .slice(0, 4);
      if (typeof v.reply === 'string') return { reply: v.reply.trim(), actions };
    } catch { /* fall through */ }
  }
  return { reply: text.replace(/^```\w*|```$/g, '').trim(), actions: [] };
}

module.exports = { ACTIONS, gatherContext, buildPrompt, parseAnswer };
