const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

// Demo kit: makes every feature demonstrable on stage without depending on the real world — a staged
// camera scene replayed through the real AI pipeline, a simulated walk away from home, Margaret's
// answer on her behalf, and a reset. Only active when DEMO_MODE=1, and only for family accounts.

const JOURNAL_DIR = process.env.JOURNAL_DIR || path.join(__dirname, '..', 'journal');
const isDemoMode = () => process.env.DEMO_MODE === '1';

// ---- demo devices: keep simulated readings apart from the real phone and camera ---------------

async function demoDevice(patientId, kind) {
  const identifier = `demo:${kind}`;
  const found = await prisma.device.findFirst({ where: { patientId, identifier } });
  if (found) return found;
  return prisma.device.create({
    data: {
      patientId,
      identifier,
      deviceType: kind === 'camera' ? 'esp32cam' : 'watch',
      apiKeyHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
    },
  });
}

// ---- scenes: real photos saved once, replayed later ---------------------------------------------

const scenesFile = (pid) => path.join(JOURNAL_DIR, pid, 'demo-scenes.json');

async function listScenes(pid) {
  try {
    return JSON.parse(await fs.readFile(scenesFile(pid), 'utf8'));
  } catch {
    return {};
  }
}

async function saveScene(pid, name, entry) {
  const scenes = await listScenes(pid);
  scenes[name] = { image_public_id: entry.imagePublicId, activity: entry.payload?.activity || null, saved_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(scenesFile(pid)), { recursive: true });
  await fs.writeFile(scenesFile(pid), JSON.stringify(scenes, null, 2));
  return scenes;
}

async function sceneImageBase64(publicId) {
  const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${publicId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch the saved photo (${res.status})`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ---- simulated walk ---------------------------------------------------------------------------

const walks = new Map(); // patientId -> { until, timer, direction }
const isWalkActive = (pid) => (walks.get(pid)?.until || 0) > Date.now();

function stopWalk(pid) {
  const w = walks.get(pid);
  if (w?.timer) clearInterval(w.timer);
  walks.delete(pid);
}

/**
 * Walks the demo phone from Home outwards ("away": 8 steps of ~70 m, every 4 s, then stays out) or
 * from the last point back to Home ("home"). Each step goes through the same code as a real ping, so
 * alerts, Drex, the journal, the map trail and Guide home all react exactly as they would for real.
 */
async function startWalk(pid, direction, recordPing) {
  stopWalk(pid);
  const zones = await prisma.geofenceZone.findMany({ where: { patientId: pid } });
  const home = zones.find((z) => /home/i.test(z.name)) || zones[0];
  if (!home) throw new Error('Set up a Home place first (Places page)');
  const phone = await demoDevice(pid, 'phone');

  const mLat = (m) => m / 111320;
  const mLng = (m) => m / (111320 * Math.cos((home.centerLat * Math.PI) / 180));
  let points;
  if (direction === 'away') {
    // Head the way that leaves EVERY safe place soonest (other places may sit next to Home), with a
    // little zig-zag so the trail looks walked. 9 steps of ~75 m.
    const outside = (lat, lng) => zones.every((z) => {
      const dy = (lat - z.centerLat) * 111320;
      const dx = (lng - z.centerLng) * 111320 * Math.cos((z.centerLat * Math.PI) / 180);
      return Math.hypot(dx, dy) > z.radiusMeters;
    });
    let best = { bearing: 45, firstOut: 99 };
    for (let deg = 0; deg < 360; deg += 30) {
      const r = (deg * Math.PI) / 180;
      let firstOut = 99;
      for (let i = 1; i <= 8; i++) {
        if (outside(home.centerLat + mLat(i * 75 * Math.cos(r)), home.centerLng + mLng(i * 75 * Math.sin(r)))) { firstOut = i; break; }
      }
      if (firstOut < best.firstOut) best = { bearing: deg, firstOut };
    }
    const r = (best.bearing * Math.PI) / 180;
    points = Array.from({ length: 9 }, (_, i) => {
      const m = i * 75;
      const wiggle = (i % 2 ? 1 : -1) * Math.min(i, 2) * 8;
      return {
        lat: home.centerLat + mLat(m * Math.cos(r) - wiggle * Math.sin(r)),
        lng: home.centerLng + mLng(m * Math.sin(r) + wiggle * Math.cos(r)),
      };
    });
  } else {
    const last = await prisma.logEntry.findFirst({ where: { patientId: pid, entryType: 'geofence', deviceId: phone.id }, orderBy: { timestamp: 'desc' } });
    const from = last?.payload?.lat ? { lat: last.payload.lat, lng: last.payload.lng } : { lat: home.centerLat + mLat(450), lng: home.centerLng + mLng(400) };
    points = Array.from({ length: 7 }, (_, i) => ({
      lat: from.lat + ((home.centerLat - from.lat) * (i + 1)) / 7,
      lng: from.lng + ((home.centerLng - from.lng) * (i + 1)) / 7,
    }));
  }

  let i = 0;
  const w = { direction, until: Date.now() + (direction === 'away' ? 15 * 60000 : points.length * 4000 + 30000) };
  const step = async () => {
    if (i >= points.length) {
      clearInterval(w.timer);
      w.timer = null;
      if (direction === 'home') w.until = Date.now() + 30000; // let the real phone take over shortly
      return;
    }
    const p = points[i++];
    await recordPing(phone, p.lat, p.lng, new Date(), { demo: true }).catch((e) => console.error('[demo walk]', e.message));
  };
  w.timer = setInterval(step, 4000);
  walks.set(pid, w);
  await step();
  return { steps: points.length, every_s: 4, home: home.name };
}

// ---- reset ----------------------------------------------------------------------------------------

/** Clears what demos create today (actions, answers, broadcasts, simulated readings, queue rows). */
async function reset(pid) {
  stopWalk(pid);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const demoDevices = await prisma.device.findMany({ where: { patientId: pid, identifier: { startsWith: 'demo:', not: 'demo:history' } }, select: { id: true } });
  const [commands, broadcasts, entries, jobs, events, rules] = await Promise.all([
    prisma.deviceCommand.deleteMany({ where: { patientId: pid, createdAt: { gte: since } } }),
    prisma.familyBroadcast.deleteMany({ where: { patientId: pid, createdAt: { gte: since } } }),
    prisma.logEntry.deleteMany({ where: { patientId: pid, deviceId: { in: demoDevices.map((d) => d.id) } } }),
    prisma.aiJob.deleteMany({ where: { patientId: pid } }),
    prisma.familyEvent.deleteMany({ where: { patientId: pid, createdAt: { gte: since } } }),
    prisma.watchRule.deleteMany({ where: { patientId: pid, createdAt: { gte: since } } }),
  ]);
  return { commands: commands.count, broadcasts: broadcasts.count, simulated_readings: entries.count, queue_rows: jobs.count, events: events.count, rules: rules.count };
}

module.exports = { isDemoMode, demoDevice, listScenes, saveScene, sceneImageBase64, startWalk, stopWalk, isWalkActive, reset };
