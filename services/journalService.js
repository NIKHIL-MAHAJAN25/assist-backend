const fs = require('fs/promises');
const path = require('path');
const prisma = require('../config/prisma');
const { describe } = require('./commandTypes');

// The day journal: one Markdown file per patient per day, rendered from the database (the source of
// truth) by the backend alone, so concurrent helpers never write to it. Helpers read its tail for
// continuity; summaries are written from it. JOURNAL_DIR is a Docker volume in production.

const JOURNAL_DIR = process.env.JOURNAL_DIR || path.join(__dirname, '..', 'journal');
const MERGE_GAP_MIN = 15;
const KEEP_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function fileFor(patientId, day) {
  return path.join(JOURNAL_DIR, patientId, `${dayKey(day)}.md`);
}

// Turn the day's raw entries into readable, merged lines.
function renderLines(entries, attempts, commands = []) {
  const items = [];
  let lastInside = null;

  for (const e of entries) {
    const t = new Date(e.timestamp);
    const p = e.payload || {};
    const flag = e.requiresAttention ? '⚠ ' : '';
    const decided = p.decision?.drex && !p.decision.drex.error ? ` (rules ${p.decision.rules?.notify ? '✓' : '✗'}, Drex ${p.decision.drex.notify ? '✓' : '✗'})` : '';

    if (e.entryType === 'frame') {
      const quiet = p.activity_key === 'empty_room' || p.activity_key === 'not_visible';
      const key = quiet ? 'quiet' : p.activity_key || p.activity;
      const prev = items[items.length - 1];
      // Family the camera recognised in this photo (faceService), e.g. ["Sarah"].
      const names = (p.people || []).map((x) => x.name).filter(Boolean);
      if (prev && prev.kind === 'frame' && prev.key === key && !e.requiresAttention && t - prev.end <= MERGE_GAP_MIN * 60000) {
        prev.end = t;
        for (const n of names) if (!prev.people.includes(n)) prev.people.push(n);
        continue;
      }
      items.push({
        kind: 'frame', key, start: t, end: t, people: [...names],
        text: quiet
          ? 'Camera · no one in view'
          : `${flag}Camera · ${p.activity || 'activity'}${p.person_state && p.person_state !== 'not visible' ? ` (${p.person_state})` : ''}${flag ? decided : ''}`,
      });
    } else if (e.entryType === 'geofence') {
      const inside = p.inside_safe_zone !== false;
      if (lastInside === null) {
        lastInside = inside;
        if (inside) continue; // first ping of the day inside: nothing to say
      } else if (inside === lastInside && !e.requiresAttention) {
        continue; // routine ping, no change
      }
      const text = inside
        ? 'Back inside the safe places'
        : lastInside === false
          ? `${flag}Still outside the safe places${e.requiresAttention ? ' · family reminded' : ''}`
          : `${flag}Left the safe places${e.requiresAttention ? ' · family alerted' : ''}${decided}`;
      lastInside = inside;
      items.push({ kind: 'place', start: t, end: t, text });
    } else if (e.entryType === 'heartrate') {
      if (!e.requiresAttention) continue;
      items.push({ kind: 'watch', start: t, end: t, text: `⚠ Watch · ${p.scenario || 'alert'} (heart rate ${p.heart_rate ?? '?'})` });
    } else if (e.entryType === 'sighting') {
      items.push({
        kind: 'sighting', start: t, end: t,
        text: p.kind === 'location' ? '⚠ Someone who found them shared a location from the emergency tag' : '⚠ Someone tapped the emergency tag',
      });
    }
    if (e.acknowledgedAt && e.requiresAttention) {
      items[items.length - 1].text += ` · seen by family ${hm(new Date(e.acknowledgedAt))}`;
    }
  }

  if (attempts.length) {
    const byTime = new Map();
    for (const a of attempts) {
      const k = hm(new Date(a.timestamp)).slice(0, 4); // group by ~10 minutes
      const g = byTime.get(k) || { start: new Date(a.timestamp), right: 0, total: 0 };
      g.total += 1;
      if (a.correct) g.right += 1;
      byTime.set(k, g);
    }
    for (const g of byTime.values()) items.push({ kind: 'quiz', start: g.start, end: g.start, text: `Memory quiz · ${g.right} of ${g.total} right` });
  }

  for (const c of commands) {
    if (['expired'].includes(c.status)) continue;
    items.push({ kind: 'family', start: new Date(c.createdAt), end: new Date(c.createdAt), text: `${c.senderName} → phone · ${describe(c)}` });
    if (c.type === 'ask' && c.payload?.reply && c.payload.replied_at) {
      items.push({ kind: 'reply', start: new Date(c.payload.replied_at), end: new Date(c.payload.replied_at), text: `Answered ${c.senderName}: "${c.payload.reply}"` });
    }
  }

  items.sort((a, b) => a.start - b.start);
  return items.map((i) => {
    const span = i.end - i.start >= 60000 ? `${hm(i.start)}–${hm(i.end)}` : hm(i.start);
    const withPeople = i.people?.length ? ` · with ${i.people.join(' and ')}` : '';
    return `${span.padEnd(12)} ${i.text}${withPeople}`;
  });
}

async function linesFor(patientId, day = new Date()) {
  const from = dayStart(day);
  const to = new Date(from.getTime() + 86400000);
  const [entries, attempts, commands] = await Promise.all([
    prisma.logEntry.findMany({ where: { patientId, timestamp: { gte: from, lt: to } }, orderBy: { timestamp: 'asc' } }),
    prisma.quizAttempt.findMany({ where: { timestamp: { gte: from, lt: to }, quizQuestion: { patientId } }, orderBy: { timestamp: 'asc' } }),
    prisma.deviceCommand.findMany({ where: { patientId, createdAt: { gte: from, lt: to } }, orderBy: { createdAt: 'asc' } }),
  ]);
  return renderLines(entries, attempts, commands);
}

// Re-render one day's file. Cheap: a day is at most a few hundred entries.
async function writeDay(patientId, day = new Date()) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) return null;
  const lines = await linesFor(patientId, day);
  const title = `# ${patient.name.split(' ')[0]} · ${day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
  const file = fileFor(patientId, day);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${title}\n${lines.join('\n')}\n`, 'utf8');
  return { file, lines };
}

async function readDay(patientId, day = new Date()) {
  try {
    return await fs.readFile(fileFor(patientId, day), 'utf8');
  } catch {
    const r = await writeDay(patientId, day);
    return r ? fs.readFile(r.file, 'utf8') : '';
  }
}

// Last n lines of today's journal, for a helper's context.
async function tail(patientId, n = 10) {
  const text = await readDay(patientId);
  return text.split('\n').filter((l) => l && !l.startsWith('#')).slice(-n);
}

// Keep files in step with the database: re-render today's file for any patient with new or changed
// entries since the last pass, and delete files older than KEEP_DAYS.
let lastPass = new Date(Date.now() - 86400000);
async function refreshChanged() {
  const since = lastPass;
  lastPass = new Date();
  const changed = await prisma.logEntry.findMany({
    where: { OR: [{ createdAt: { gte: since } }, { acknowledgedAt: { gte: since } }] },
    select: { patientId: true },
    distinct: ['patientId'],
  });
  const commanded = await prisma.deviceCommand.findMany({
    where: { OR: [{ createdAt: { gte: since } }, { doneAt: { gte: since } }] },
    select: { patientId: true },
    distinct: ['patientId'],
  });
  for (const c of commanded) if (!changed.some((x) => x.patientId === c.patientId)) changed.push(c);
  for (const { patientId } of changed) await writeDay(patientId).catch((e) => console.error('[journal]', e.message));
}

async function prune() {
  const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86400000));
  let dirs = [];
  try { dirs = await fs.readdir(JOURNAL_DIR); } catch { return; }
  for (const d of dirs) {
    const files = await fs.readdir(path.join(JOURNAL_DIR, d)).catch(() => []);
    for (const f of files) {
      if (f.slice(0, 10) < cutoff) await fs.unlink(path.join(JOURNAL_DIR, d, f)).catch(() => {});
    }
  }
}

function start() {
  const tick = () => refreshChanged().catch((e) => console.error('[journal]', e.message));
  tick();
  setInterval(tick, 20000).unref();
  prune();
  setInterval(prune, 6 * 3600 * 1000).unref();
}

module.exports = { start, writeDay, readDay, tail, linesFor, fileFor, dayKey, renderLines, JOURNAL_DIR };
