const prisma = require('../config/prisma');
const journal = require('./journalService');
const { getPatientStatus } = require('./patientStatusService');

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
  const [status, journalText, zones, commands] = await Promise.all([
    getPatientStatus(patient),
    journal.writeDay(patient.id).then(() => journal.readDay(patient.id)),
    prisma.geofenceZone.findMany({ where: { patientId: patient.id }, select: { name: true } }),
    prisma.deviceCommand.findMany({ where: { patientId: patient.id }, orderBy: { createdAt: 'desc' }, take: 5 }),
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
    `Messages recently sent to their phone: ${commands.length ? commands.map((c) => `"${c.payload.text}" (${c.status}, ${ago(c.createdAt)}, by ${c.senderName})`).join('; ') : 'none'}`,
  ];
  return {
    text: `${lines.join('\n')}\n\nToday's journal (oldest first):\n${journalText.trim() || '(empty)'}`,
    sources: ['location', 'camera', 'journal', 'alerts', ...(commands.length ? ['messages'] : [])],
    status,
  };
}

function buildPrompt({ firstName, caregiverName, context, history, message }) {
  const convo = (history || []).slice(-8).map((t) => `${t.role === 'user' ? caregiverName : 'Assistant'}: ${String(t.text).slice(0, 600)}`).join('\n');
  return `You are the Assist family assistant. You help ${caregiverName}, a family member of ${firstName}, who lives
with memory loss and is watched over by a home camera, their phone's location, and reminders. Answer ONLY from
the context below; if it doesn't say, say you don't know. Be brief and warm (1–3 sentences), plain words, no
medical advice. If something looks unsafe, say so plainly and suggest calling them.

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
        .slice(0, 3);
      if (typeof v.reply === 'string') return { reply: v.reply.trim(), actions };
    } catch { /* fall through */ }
  }
  return { reply: text.replace(/^```\w*|```$/g, '').trim(), actions: [] };
}

module.exports = { ACTIONS, gatherContext, buildPrompt, parseAnswer };
