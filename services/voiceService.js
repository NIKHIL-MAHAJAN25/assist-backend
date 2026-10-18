const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { genAI } = require('../config/gemini');

// Natural speech for the patient's phone: Gemini text-to-speech on the server, played on the phone as an
// audio file. Everything is cached — the same words in the same voice are generated once, ever (Cloudinary
// holds the audio, a small index file maps text → URL). Anything that fails or is slow returns null and
// the phone falls back to its own voice, so nothing is ever left unsaid.

const JOURNAL_DIR = process.env.JOURNAL_DIR || path.join(__dirname, '..', 'journal');
const INDEX = path.join(JOURNAL_DIR, 'tts-index.json');
const AUDIO_DIR = path.join(JOURNAL_DIR, 'tts');
const VOICE = process.env.TTS_VOICE || 'Sulafat'; // warm, calm
// 3.1 first (newer, has a free tier); 2.5 as a fallback. Both ~4 s for a short line.
const MODELS = [process.env.TTS_MODEL, 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean);
const STYLE = 'Read this aloud gently, warmly and a little slowly, like a caring family member talking to someone they love:';
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 12000);

let index = null;
const inflight = new Map();
let workingModel = null;

const enabled = () => process.env.TTS !== 'off' && Boolean(process.env.GEMINI_API_KEY);

async function loadIndex() {
  if (index) return index;
  try {
    index = JSON.parse(await fs.readFile(INDEX, 'utf8'));
  } catch {
    index = {};
  }
  return index;
}

async function saveIndex() {
  await fs.mkdir(path.dirname(INDEX), { recursive: true });
  await fs.writeFile(INDEX, JSON.stringify(index));
}

const keyFor = (text) => crypto.createHash('sha256').update(`${VOICE}|${STYLE}|${text}`).digest('hex').slice(0, 24);

/** Raw 16-bit PCM (what Gemini returns) → a WAV file. */
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synthesize(text) {
  const models = workingModel ? [workingModel] : MODELS;
  let lastErr;
  for (const model of models) {
    try {
      const res = await genAI.models.generateContent({
        model,
        contents: [{ parts: [{ text: `${STYLE} ${text}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) throw new Error('no audio in the answer');
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1]) || 24000;
      workingModel = model;
      return pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Natural-speech URL (mp3) for these words, from the cache or freshly made. null when TTS is off, slow
 * or failing — callers then let the phone speak with its own voice.
 */
async function speechFor(text, { timeoutMs = TIMEOUT_MS } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
  if (!clean || !enabled()) return null;
  await loadIndex();
  const key = keyFor(clean);
  if (index[key]) return index[key];
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      // Kept on the server's own disk (the journal volume) and served from our domain — no upload step,
      // so a new line is ready as soon as Gemini has spoken it. The key is an unguessable hash.
      const wav = await synthesize(clean);
      await fs.mkdir(AUDIO_DIR, { recursive: true });
      await fs.writeFile(path.join(AUDIO_DIR, `${key}.wav`), wav);
      const url = `${(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '')}/tts/${key}.wav`;
      index[key] = url;
      await saveIndex();
      return url;
    })().finally(() => inflight.delete(key)));
  }
  const timeout = new Promise((r) => setTimeout(() => r(null), timeoutMs));
  return Promise.race([inflight.get(key).catch((e) => { console.error('[tts]', e.message); return null; }), timeout]);
}

// ---- what the phone says for each action (keep in step with MonitoringService's own fallback lines) ----

function phraseFor(cmd, first) {
  const p = cmd.payload || {};
  const from = cmd.senderName;
  switch (cmd.type) {
    case 'speak': return `Message from ${from}. ${p.text}`;
    case 'ask': return p.fall_check ? `${first}, are you okay? Tap I'm okay, or tell me if you need help.` : `${first}, ${from} is asking: ${p.question}`;
    case 'reminder': return `${first}, a reminder from ${from}. ${p.text}`;
    case 'story': return p.text;
    case 'guide_home': return `${first}, it's time to head home. Look at your phone. The arrow will show you the way.`;
    case 'quiz': return `${first}, ${from} sent you a few questions about your day. Tap Questions when you're ready.`;
    case 'calm':
      return `${first}, it's ${from}. You're safe. Everything is all right. Let's breathe together. ... Breathe in slowly. ... And out. ... Breathe in. ... And out. ... You're doing well. We love you.`;
    default: return null;
  }
}

/** Fixed phrases made ahead of time so the urgent ones never wait on Gemini. */
async function warmUp(patients) {
  if (!enabled()) return;
  for (const pt of patients) {
    const first = (pt.name || 'there').split(' ')[0];
    for (const type of ['guide_home']) await speechFor(phraseFor({ type, payload: {} }, first), { timeoutMs: 60000 });
    await speechFor(phraseFor({ type: 'ask', payload: { fall_check: true } }, first), { timeoutMs: 60000 });
  }
}

/**
 * Give a freshly created command its natural voice. The command is created with voice_pending=true;
 * the phone doesn't pick it up until the audio is ready or HOLD_MS has passed (then it uses its own voice).
 */
const HOLD_MS = 10000;
// A long, unhurried text (the bedtime story) may wait longer for its natural voice than a quick message.
const holdFor = (type) => (type === 'story' ? 45000 : HOLD_MS);
async function prepareCommand(cmd) {
  const prisma = require('../config/prisma');
  try {
    const pt = await prisma.patient.findUnique({ where: { id: cmd.patientId }, select: { name: true } });
    const phrase = phraseFor(cmd, (pt?.name || 'there').split(' ')[0]);
    const url = phrase ? await speechFor(phrase, { timeoutMs: holdFor(cmd.type) }) : null;
    const fresh = await prisma.deviceCommand.findUnique({ where: { id: cmd.id } });
    if (!fresh) return;
    await prisma.deviceCommand.update({ where: { id: cmd.id }, data: { payload: { ...fresh.payload, voice_pending: false, ...(url && { audio_url: url }) } } });
  } catch (e) {
    console.error('[tts]', e.message);
  }
}
const SPOKEN = new Set(['speak', 'ask', 'reminder', 'story', 'guide_home', 'quiz', 'calm']);
const wantsVoice = (type) => enabled() && SPOKEN.has(type);

module.exports = { AUDIO_DIR, speechFor, phraseFor, warmUp, enabled, prepareCommand, wantsVoice, holdFor, HOLD_MS, VOICE };
