// One prompt and one vocabulary for every provider (Claude workers, Codex workers, Gemini fallback),
// so the log reads the same whoever answered. decisions-log 2026-10-17: fixed activity vocabulary.

const ACTIVITIES = {
  eating: 'eating a meal or snack',
  drinking: 'drinking (tea, water, etc.)',
  cooking: 'cooking or preparing food',
  taking_medication: 'taking medication',
  watching_tv: 'watching TV',
  reading: 'reading',
  resting: 'resting or sitting in a chair',
  sleeping: 'sleeping or lying down to sleep',
  walking_around: 'walking around the room',
  cleaning: 'cleaning or tidying',
  on_phone: 'on the phone',
  with_visitor: 'with a visitor',
  getting_ready_to_leave: 'putting on shoes or coat, near the door',
  out_of_house: 'not home / left the house',
  fallen: 'on the floor, may have fallen',
  distressed: 'looks distressed or confused',
  empty_room: 'empty room, nobody visible',
  not_visible: 'camera view unclear or blocked',
  other: 'something else',
};

const ALERT_KEYS = new Set(['fallen', 'distressed']);

const FRAME_INSTRUCTIONS = `You are the perception step of a home-safety camera for a person living with
memory loss. Look at ONE still photo from their home camera and describe it for their family.

Rules:
- "activity_key" MUST be exactly one of: ${Object.keys(ACTIVITIES).join(', ')}.
  Meanings: ${Object.entries(ACTIVITIES).map(([k, v]) => `${k} = ${v}`).join('; ')}.
- "activity" is a short plain phrase a family member would say (max 8 words), e.g. "eating breakfast at the table".
- "person_state" is posture and mood in a few words, or "not visible".
- "objects_of_note": up to 4 notable objects.
- "confidence": 0 to 1.
- "requires_attention": true only for a fall, visible distress, or a hazard (smoke, open flame left alone, water on floor).
- Use the recent journal lines for continuity: if they were eating a minute ago and still are, say so.
- Never guess names or identities.

Reply with ONLY one JSON object, no prose, no code fences:
{"activity_key": "...", "activity": "...", "person_state": "...", "objects_of_note": ["..."], "confidence": 0.9, "requires_attention": false}`;

function framePrompt(journalTail) {
  const ctx = journalTail && journalTail.length ? journalTail.join('\n') : '(nothing yet today)';
  return `${FRAME_INSTRUCTIONS}\n\nRecent journal lines (oldest first):\n${ctx}`;
}

const RANGE_WORDS = { today: 'today so far', morning: 'this morning', week: 'the last seven days' };

function summaryPrompt({ firstName, range, journal }) {
  return `You write short updates for the family of ${firstName}, who lives with memory loss.
Below is the activity journal for ${RANGE_WORDS[range] || range}. Write a warm, plain summary of
3 to 5 sentences: how the day went, meals, time out of the house, anything flagged, and how they
responded. Use "${firstName}", never "the patient". No medical advice. Only use what the journal says;
if there are long gaps with no entries, say the camera saw nothing then rather than guessing.

Reply with ONLY the summary text.

Journal:
${journal}`;
}

// Normalise and check a frame answer from any provider. Returns { ok, value } or { ok:false, error }.
function validateFrame(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const m = v.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: 'no JSON object in answer' };
    try { v = JSON.parse(m[0]); } catch (e) { return { ok: false, error: `bad JSON: ${e.message}` }; }
  }
  if (!v || typeof v !== 'object') return { ok: false, error: 'answer is not an object' };
  const key = String(v.activity_key || '').trim().toLowerCase();
  if (!ACTIVITIES[key]) return { ok: false, error: `activity_key "${key}" not in vocabulary` };
  const activity = String(v.activity || ACTIVITIES[key]).trim().slice(0, 120);
  const confidence = Math.max(0, Math.min(1, Number(v.confidence) || 0));
  return {
    ok: true,
    value: {
      activity_key: key,
      activity,
      person_state: String(v.person_state || 'not visible').trim().slice(0, 80),
      objects_of_note: Array.isArray(v.objects_of_note) ? v.objects_of_note.slice(0, 4).map((o) => String(o).slice(0, 40)) : [],
      confidence,
      requires_attention: Boolean(v.requires_attention) || ALERT_KEYS.has(key),
    },
  };
}

module.exports = { ACTIVITIES, framePrompt, summaryPrompt, validateFrame };
