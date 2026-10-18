const { genAI, GEMINI_MODEL } = require('../config/gemini');

// Section 8.1 — structured JSON output + few-shot prompting for frame -> meaning.
// Chain-of-thought is requested but never persisted: only the final JSON is stored.
const FRAME_SYSTEM_PROMPT = `You are the perception module of a passive home-safety camera system for a
person with Alzheimer's/memory impairment living semi-independently. You are shown one still frame at a
time and must describe what is happening for a caregiver, then decide if it needs attention.

Think briefly step by step, then output ONLY a JSON object matching the schema. Do not include your
reasoning in the output.

Examples:
Frame: an empty, well-lit kitchen, kettle on the counter, nothing out of place.
Reasoning: No person visible, no hazard, nothing unusual.
Output: {"activity": "empty room, no activity", "objects_of_note": ["kettle"], "person_state": "not visible", "confidence": 0.95, "requires_attention": false}

Frame: a person seated at a table eating from a bowl, calm posture.
Reasoning: Normal daytime activity, person is safe and engaged.
Output: {"activity": "eating a meal at the table", "objects_of_note": ["bowl", "table"], "person_state": "seated, calm", "confidence": 0.9, "requires_attention": false}

Frame: a person on the floor near an overturned chair, not moving.
Reasoning: A fall is a safety-critical event and needs immediate attention.
Output: {"activity": "person appears to have fallen near an overturned chair", "objects_of_note": ["chair"], "person_state": "on floor, not moving", "confidence": 0.85, "requires_attention": true}`;

const FRAME_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    activity: { type: 'string' },
    objects_of_note: { type: 'array', items: { type: 'string' } },
    person_state: { type: 'string' },
    confidence: { type: 'number' },
    requires_attention: { type: 'boolean' },
  },
  required: ['activity', 'objects_of_note', 'person_state', 'confidence', 'requires_attention'],
};

async function analyzeFrame({ base64Image, mimeType = 'image/jpeg' }) {
  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { text: FRAME_SYSTEM_PROMPT },
          { inlineData: { mimeType, data: base64Image } },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: FRAME_RESPONSE_SCHEMA,
    },
  });

  return JSON.parse(response.text);
}

// Section 8.4 — grounded mini-RAG. Retrieval is the caller's DB query; this is just the generation step.
const QUIZ_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          correct_answer: { type: 'string' },
          source_log_entry_id: { type: 'string' },
        },
        required: ['question', 'correct_answer', 'source_log_entry_id'],
      },
    },
  },
  required: ['questions'],
};

async function generateQuizQuestions(logEntries) {
  const groundingText = logEntries
    .map((e) => `log_entry_id=${e.id} timestamp=${e.timestamp.toISOString()} payload=${JSON.stringify(e.payload)}`)
    .join('\n');

  const prompt = `Below are today's activity log entries for a person with memory impairment. Generate
3-5 simple recall quiz questions grounded ONLY in these entries — never invent details not present here.
Each question must reference the log_entry_id it was grounded in via source_log_entry_id. Keep questions
short and low-cognitive-load (e.g. "What did you eat for lunch?").

Log entries:
${groundingText}`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: QUIZ_RESPONSE_SCHEMA,
    },
  });

  return JSON.parse(response.text).questions;
}

// Section 8.6 — STT/TTS clarification step. The clarification itself is the technique being
// demonstrated; raw STT/TTS plumbing lives in the companion app (later session).
async function clarifyTranscript(rawTranscript) {
  const prompt = `Raw speech-to-text transcript from a person with memory impairment, which may contain
fragmentation, repetition, or false starts: "${rawTranscript}"

Infer their most likely intended request in one clear sentence. Respond with just that sentence, no
preamble.`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  return response.text.trim();
}

// Object/day recall — grounded retrieval (caller's DB query) + generation over that slice of log_entries.
async function answerRecallQuery(queryText, logEntries) {
  const groundingText = logEntries
    .map((e) => `timestamp=${e.timestamp.toISOString()} payload=${JSON.stringify(e.payload)}`)
    .join('\n');

  const prompt = `A person with memory impairment is asking: "${queryText}"

Answer using ONLY the activity log below. If the answer isn't in the log, say you don't have a record of
it — never guess. Keep the answer to one short, simple sentence suitable for text-to-speech.

Activity log:
${groundingText}`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  return response.text.trim();
}

// Fallback for the helper queue: same prompt the helpers get (services/prompts.js), thinking off so a
// frame answers in a couple of seconds, one retry on a rate limit.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    // 429 = slow down, 503 = Gemini overloaded: both pass quickly, so wait once and try again.
    if (/429|503|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(String(e?.status) + String(e?.message))) {
      await new Promise((r) => setTimeout(r, 3000));
      return fn();
    }
    throw e;
  }
}

async function analyzeFrameWithPrompt({ base64Image, prompt, mimeType = 'image/jpeg' }) {
  const response = await withRetry(() => genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Image } }] }],
    config: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
  }));
  return response.text;
}

async function generateText(prompt) {
  const response = await withRetry(() => genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  }));
  return response.text.trim();
}

module.exports = { analyzeFrame, generateQuizQuestions, clarifyTranscript, answerRecallQuery, analyzeFrameWithPrompt, generateText };
