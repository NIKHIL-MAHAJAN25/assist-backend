const path = require('path');
const prisma = require('../config/prisma');
const { mergePayload } = require('../utils/mergePayload');

// Face recognition on camera photos. Uses the same three face-api models as the family website
// (tiny face detector, 68-point landmarks, 128-number face fingerprint), so a person enrolled on the
// People page can be matched in a camera photo. Runs on the server's CPU through TensorFlow's
// WebAssembly backend: no native build, works the same on the laptop and in Docker.
//
// FACES=off turns it off. FACE_MATCH_DISTANCE (default 0.55) is how close two fingerprints must be;
// lower is stricter. face-api's own guidance is 0.6; 0.55 trades a few misses for fewer wrong names.

const MATCH_DISTANCE = Number(process.env.FACE_MATCH_DISTANCE || 0.55);
const MODEL_DIR = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');

let ready = null;
let faceapi = null;
let tf = null;

const enabled = () => process.env.FACES !== 'off';

function init() {
  if (!ready) {
    ready = (async () => {
      tf = require('@tensorflow/tfjs');
      const wasm = require('@tensorflow/tfjs-backend-wasm');
      wasm.setWasmPaths(path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep);
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await tf.setBackend('wasm');
      await tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(MODEL_DIR),
        faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR),
        faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR),
      ]);
      console.log('[faces] models ready (wasm)');
    })().catch((e) => {
      ready = null; // let a later call try again
      throw e;
    });
  }
  return ready;
}

/** JPEG bytes → an RGB tensor face-api can read. */
function toTensor(buffer) {
  const jpeg = require('jpeg-js');
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
  return tf.tensor3d(img.data, [img.height, img.width, 3], 'int32');
}

/** Every face in a photo with its fingerprint and box. */
async function facesIn(buffer) {
  await init();
  const input = toTensor(buffer);
  try {
    // 416 suits a room seen from a corner. A face that fills the frame (someone right up at the
    // camera) is missed at that size, so try smaller detector sizes before giving up.
    let found = [];
    for (const inputSize of [416, 224, 128]) {
      found = await faceapi
        .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (found.length) break;
    }
    return found.map((f) => ({
      descriptor: Array.from(f.descriptor),
      score: Math.round(f.detection.score * 100) / 100,
      box: { x: Math.round(f.detection.box.x), y: Math.round(f.detection.box.y), w: Math.round(f.detection.box.width), h: Math.round(f.detection.box.height) },
    }));
  } finally {
    input.dispose();
  }
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Who of the enrolled family is in this photo. Each face gets its nearest enrolled person if close
 * enough; a person is only named once per photo (their closest face wins).
 */
async function recognise(buffer, enrolled) {
  const faces = await facesIn(buffer);
  const people = [];
  let unknown = 0;
  for (const f of faces) {
    let best = null;
    for (const e of enrolled) {
      if (!Array.isArray(e.referenceEmbedding) || e.referenceEmbedding.length !== f.descriptor.length) continue;
      const d = distance(f.descriptor, e.referenceEmbedding);
      if (!best || d < best.d) best = { e, d };
    }
    if (best && best.d <= MATCH_DISTANCE) {
      const prev = people.find((p) => p.face_id === best.e.id);
      if (!prev) people.push({ face_id: best.e.id, name: best.e.name, distance: Math.round(best.d * 100) / 100, box: f.box });
      else if (best.d < prev.distance) Object.assign(prev, { distance: Math.round(best.d * 100) / 100, box: f.box });
    } else {
      unknown += 1;
    }
  }
  return { faces: faces.length, people, unknown };
}

/** The name as the family wrote it, without a bracketed relation: "Sarah (daughter)" → "Sarah". */
const shortName = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '').trim() || name;

/**
 * Runs after a camera moment is saved: records who was recognised on the entry (log_entry_faces +
 * payload.people / payload.unknown_faces). Never throws — a face problem must not lose a moment.
 */
async function recogniseEntry(entry, imageBase64) {
  if (!enabled() || !imageBase64) return null;
  try {
    const enrolled = await prisma.enrolledFace.findMany({ where: { patientId: entry.patientId } });
    const started = Date.now();
    const result = await recognise(Buffer.from(imageBase64, 'base64'), enrolled);
    if (!result.faces) return result;
    await prisma.$transaction(result.people.map((p) => prisma.logEntryFace.upsert({
      where: { logEntryId_enrolledFaceId: { logEntryId: entry.id, enrolledFaceId: p.face_id } },
      update: {},
      create: { logEntryId: entry.id, enrolledFaceId: p.face_id },
    })));
    // Merged in the database: the decision layer writes to the same entry at about the same time.
    await mergePayload(entry.id, {
      people: result.people.map((p) => ({ name: shortName(p.name), full_name: p.name, face_id: p.face_id, distance: p.distance })),
      unknown_faces: result.unknown,
      faces_ms: Date.now() - started,
    });
    if (result.people.length) console.log(`[faces] ${entry.id}: ${result.people.map((p) => `${p.name} (${p.distance})`).join(', ')}`);
    return result;
  } catch (e) {
    console.error('[faces]', e.message);
    return null;
  }
}

const VISIT_GAP_MS = 2 * 3600 * 1000; // one "Sarah is here" per person per two hours

/** "Sarah (daughter)" → "daughter", or null. */
const relationOf = (name) => (/\(([^)]+)\)\s*$/.exec(String(name || ''))?.[1] || '').trim() || null;

/**
 * Someone the family enrolled was recognised: tell the family ("Sarah was seen at home"), and, if
 * the family turned it on, say it to her on the phone ("Sarah, your daughter, is here to see you").
 * Each person at most once per VISIT_GAP_MS, so a long visit isn't announced every few seconds.
 */
async function announceVisitors(entry, people) {
  if (!people?.length) return;
  const patient = await prisma.patient.findUnique({ where: { id: entry.patientId }, select: { name: true, announceFaces: true } });
  if (!patient) return;
  const first = patient.name.split(' ')[0];
  const since = new Date(Date.now() - VISIT_GAP_MS);
  const voice = require('./voiceService');

  for (const p of people) {
    const recent = await prisma.familyEvent.findFirst({
      where: { patientId: entry.patientId, kind: 'visitor', createdAt: { gte: since }, refId: p.face_id },
      select: { id: true },
    });
    if (recent) continue;
    const name = shortName(p.name);
    await prisma.familyEvent.create({
      data: {
        patientId: entry.patientId,
        kind: 'visitor',
        severity: 'info',
        title: `${name} was seen at home with ${first}`,
        body: `The home camera recognised ${name}${patient.announceFaces ? `, and ${first}'s phone told her who's there` : ''}.`,
        refId: p.face_id,
      },
    });
    if (!patient.announceFaces) continue;
    const rel = relationOf(p.name);
    const text = rel ? `${first}, ${name}, your ${rel}, is here to see you.` : `${first}, ${name} is here to see you.`;
    const cmd = await prisma.deviceCommand.create({
      data: {
        patientId: entry.patientId,
        type: 'speak',
        payload: { text, face_id: p.face_id, log_entry_id: entry.id, ...(voice.wantsVoice('speak') && { voice_pending: true }) },
        createdBy: 'system',
        senderName: 'Assist',
        expiresAt: new Date(Date.now() + 5 * 60000), // a late "she's here" is wrong, not just late
      },
    });
    if (voice.wantsVoice('speak')) voice.prepareCommand(cmd);
  }
}

module.exports = { init, facesIn, recognise, recogniseEntry, announceVisitors, shortName, relationOf, enabled, MATCH_DISTANCE };
