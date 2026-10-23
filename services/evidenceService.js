const prisma = require('../config/prisma');

// Evidence for the family Assistant (Batch E): today's log turned into a short numbered list the AI
// can cite ("had lunch at 13:10 [E4]"), so every claim in an answer can be traced back to the photo
// or reading it came from — and, for alerts, to how the system decided.

const MERGE_GAP_MS = 15 * 60000;
const MAX_ITEMS = 40;
const QUIET = new Set(['empty_room', 'not_visible']);

const hhmm = (d) => new Date(d).toTimeString().slice(0, 5);

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Who described a photo, how sure it was, and what the rules and Drex made of it. */
function decisionOf(entry) {
  const p = entry.payload || {};
  const d = p.decision || null;
  return {
    described_by: p.analysed_by || null,
    confidence: typeof p.confidence === 'number' ? Math.round(p.confidence * 100) / 100 : null,
    rules: d?.rules ? { alert: Boolean(d.rules.notify) } : { alert: Boolean(entry.requiresAttention) },
    drex: d?.drex
      ? d.drex.error
        ? { error: 'unavailable' }
        : { alert: Boolean(d.drex.notify), probability: d.drex.notify_p ?? null, urgency: d.drex.urgency ?? null }
      : null,
    mode: d?.mode || null,
    decided_by: d?.decided_by || 'rules',
    final: entry.requiresAttention ? 'alert' : 'logged',
  };
}

function frameLabel(p) {
  if (QUIET.has(p.activity_key)) return 'no one in view';
  const state = p.person_state && !/not visible|unknown/i.test(p.person_state) ? ` (${p.person_state})` : '';
  const people = (p.people || []).map((x) => x.name).filter(Boolean);
  return `${p.activity || p.activity_key || 'something'}${state}${people.length ? `, with ${people.join(' and ')}` : ''}`;
}

/**
 * Today's entries as evidence items, oldest first, numbered E1…En.
 * Camera photos of the same activity merge into one item (keeping its clearest/latest photo);
 * flagged entries and place changes are always their own item.
 */
async function buildEvidence(patientId) {
  const entries = await prisma.logEntry.findMany({
    where: { patientId, timestamp: { gte: startOfToday() }, entryType: { in: ['frame', 'geofence', 'sighting'] } },
    orderBy: { timestamp: 'asc' },
    select: { id: true, entryType: true, timestamp: true, payload: true, requiresAttention: true, imagePublicId: true },
  });

  const items = [];
  let lastInside = null;
  for (const e of entries) {
    const p = e.payload || {};
    const t = new Date(e.timestamp).getTime();
    if (e.entryType === 'frame') {
      const key = QUIET.has(p.activity_key) ? 'quiet' : p.activity_key || p.activity;
      const prev = items[items.length - 1];
      if (prev && prev.kind === 'camera' && prev.key === key && !e.requiresAttention && !prev.flagged && t - prev.to <= MERGE_GAP_MS) {
        prev.to = t;
        prev.count += 1;
        prev.entry_ids.push(e.id);
        if (e.imagePublicId) {
          // Keep the photo the AI was surest about; ties go to the newest.
          const c = typeof p.confidence === 'number' ? p.confidence : 0;
          if (c >= (prev.best_confidence ?? -1)) {
            prev.image_public_id = e.imagePublicId;
            prev.entry_id = e.id;
            prev.best_confidence = c;
            prev.label = frameLabel(p);
          }
        }
        continue;
      }
      items.push({
        kind: 'camera',
        key,
        from: t,
        to: t,
        count: 1,
        label: frameLabel(p),
        image_public_id: e.imagePublicId || null,
        entry_id: e.id,
        entry_ids: [e.id],
        best_confidence: typeof p.confidence === 'number' ? p.confidence : 0,
        flagged: e.requiresAttention,
        decision: e.requiresAttention || p.decision ? decisionOf(e) : null,
      });
    } else if (e.entryType === 'geofence') {
      const inside = p.inside_safe_zone !== false;
      // Only changes of place are worth citing, plus flagged reminders while outside.
      if (inside === lastInside && !e.requiresAttention) continue;
      lastInside = inside;
      items.push({
        kind: 'place',
        from: t,
        to: t,
        count: 1,
        label: inside ? 'back inside the safe places' : 'left the safe places',
        lat: p.lat ?? null,
        lng: p.lng ?? null,
        entry_id: e.id,
        entry_ids: [e.id],
        flagged: e.requiresAttention,
        decision: e.requiresAttention ? decisionOf(e) : null,
      });
    } else {
      items.push({
        kind: 'sighting',
        from: t,
        to: t,
        count: 1,
        label: p.kind === 'location' ? 'someone who found them shared a location from the emergency tag' : 'someone tapped the emergency tag',
        lat: p.lat ?? null,
        lng: p.lng ?? null,
        entry_id: e.id,
        entry_ids: [e.id],
        flagged: true,
        decision: decisionOf(e),
      });
    }
  }

  const kept = items.slice(-MAX_ITEMS);
  kept.forEach((it, i) => {
    it.id = `E${i + 1}`;
    delete it.key;
    delete it.best_confidence;
  });
  return kept;
}

/** The evidence block for the prompt. */
function evidenceText(items) {
  if (!items.length) return '(nothing recorded yet today)';
  return items
    .map((it) => {
      const when = it.to - it.from >= 60000 ? `${hhmm(it.from)}–${hhmm(it.to)}` : hhmm(it.from);
      const src = it.kind === 'camera' ? 'camera' : it.kind === 'place' ? 'phone location' : 'emergency tag';
      const extra = it.count > 1 ? ` · ${it.count} photos` : '';
      return `[${it.id}] ${when} ${it.flagged ? 'ALERT · ' : ''}${src}: ${it.label}${extra}`;
    })
    .join('\n');
}

// A citation as the AI writes it: "[E4]", or a group like "[E1, E3]" / "[E1][E3]".
const MARKER = /\s?\[(E\d{1,3}(?:\s*[,;]\s*E\d{1,3})*)\]/g;
const MAX_CITED = 6;

/** The ids an answer cited, in order of first use, limited to items that exist. */
function citedIn(text, items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const seen = [];
  for (const m of String(text || '').matchAll(/\[(E\d{1,3})\]/g)) {
    if (byId.has(m[1]) && !seen.includes(m[1])) seen.push(m[1]);
  }
  return seen.slice(0, MAX_CITED).map((id) => {
    const it = byId.get(id);
    return { ...it, from: new Date(it.from).toISOString(), to: new Date(it.to).toISOString() };
  });
}

/**
 * Normalises citations to one marker per id ("[E1][E3]"), drops ids that aren't in the evidence
 * list (the AI made them up), and keeps at most MAX_CITED distinct ids in the whole answer.
 */
function cleanMarkers(text, items) {
  const ids = new Set(items.map((it) => it.id));
  const kept = [];
  return String(text || '').replace(MARKER, (all, group) => {
    const valid = group.split(/\s*[,;]\s*/).filter((id) => {
      if (!ids.has(id)) return false;
      if (kept.includes(id)) return true;
      if (kept.length >= MAX_CITED) return false;
      kept.push(id);
      return true;
    });
    return valid.length ? ` ${valid.map((id) => `[${id}]`).join('')}` : '';
  });
}

module.exports = { buildEvidence, evidenceText, citedIn, cleanMarkers, decisionOf };
