// Everything the family can ask the patient's phone to do (Assistant tab → POST /commands → the phone
// polls GET /devices/commands). One table of types so the backend, the agent and the UI agree.
//
// Each type: `clean(body)` → payload or throws a message; `label` for logs/journal.

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function hhmmToDate(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1); // a time already gone today = tomorrow
  return d;
}

const TYPES = {
  speak: {
    label: 'Spoke',
    clean: (b) => {
      const text = str(b.text, 280);
      if (!text) throw new Error('text is required');
      return { text };
    },
  },
  ask: {
    label: 'Asked',
    clean: (b) => {
      const question = str(b.question || b.text, 200);
      if (!question) throw new Error('question is required');
      const quick = Array.isArray(b.quick) ? b.quick.map((q) => str(q, 24)).filter(Boolean).slice(0, 3) : ['Yes', 'No', 'Not yet'];
      return { question, quick };
    },
  },
  voice: {
    label: 'Voice note',
    clean: (b) => {
      const url = str(b.url, 500);
      if (!/^https:\/\/res\.cloudinary\.com\//.test(url)) throw new Error('voice note url is missing');
      return { url, seconds: Math.max(1, Math.min(120, Number(b.seconds) || 0)), text: str(b.text, 140) };
    },
  },
  ring: { label: 'Rang the phone', clean: () => ({}) },
  reminder: {
    label: 'Reminder',
    clean: (b) => {
      const text = str(b.text, 140);
      const at = b.at && !Number.isNaN(new Date(b.at).getTime()) && String(b.at).includes('T') ? new Date(b.at) : hhmmToDate(b.at);
      if (!text) throw new Error('reminder text is required');
      if (!at) throw new Error('reminder time is required (HH:MM)');
      return { text, at: at.toISOString() };
    },
  },
  capture: { label: 'Took a photo', clean: () => ({}) },
  guide_home: { label: 'Guided home', clean: () => ({}) },
  quiz: { label: 'Sent a quiz', clean: () => ({}) },
  calm: {
    label: 'Calm-down',
    clean: (b) => ({ voice_url: /^https:\/\/res\.cloudinary\.com\//.test(str(b.voice_url, 500)) ? str(b.voice_url, 500) : null }),
  },
};

/** One-line description for the journal and the agent's context. */
function describe(c) {
  const p = c.payload || {};
  switch (c.type) {
    case 'speak': return `"${p.text}"`;
    case 'ask': return `asked "${p.question}"${p.reply ? ` — answered "${p.reply}"` : ''}`;
    case 'voice': return `voice note${p.text ? ` ("${p.text}")` : ''}`;
    case 'reminder': return `reminder "${p.text}" at ${new Date(p.at).toTimeString().slice(0, 5)}`;
    case 'capture': return `took a photo${p.activity ? ` — ${p.activity}` : ''}`;
    default: return TYPES[c.type]?.label.toLowerCase() || c.type;
  }
}

module.exports = { TYPES, describe, hhmmToDate };
