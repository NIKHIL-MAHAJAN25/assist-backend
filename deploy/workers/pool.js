#!/usr/bin/env node
// Assist helper pool — runs on the host as the `assist` user (not in Docker), because the Claude Code
// and Codex sign-ins live in that user's home. No npm packages: Node 22's fetch + child_process only.
//
// Each helper loops: claim a job from the backend → run one fresh CLI call → send back the answer.
// The backend owns everything else (prompts, validation, retries, the journal, Gemini fallback).
//
// Settings (environment, e.g. from ~/.config/assist/workers.env):
//   ASSIST_API       default http://127.0.0.1:3100
//   WORKER_TOKEN     must match the backend's WORKER_TOKEN
//   CLAUDE_WORKERS   default 4      CODEX_WORKERS  default 4
//   CLAUDE_MODEL     default sonnet
//   CLAUDE_CODE_OAUTH_TOKEN  (read by the claude CLI itself)

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = (process.env.ASSIST_API || 'http://127.0.0.1:3100').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN || '';
const COUNTS = { claude: Number(process.env.CLAUDE_WORKERS ?? 4), codex: Number(process.env.CODEX_WORKERS ?? 4) };
const TIMEOUT_MS = { frame: 75000, summary: 120000 };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-workers-'));

if (TOKEN.length < 16) {
  console.error('WORKER_TOKEN is missing or too short — set it in ~/.config/assist/workers.env');
  process.exit(1);
}

const log = (id, msg) => console.log(`${new Date().toISOString().slice(11, 19)} [${id}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-token': TOKEN },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
  return res.json();
}

// Run a command with a hard timeout; resolve with stdout (or reject with stderr tail).
function run(cmd, args, { timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code}: ${(err || out).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`));
    });
  });
}

// One fresh CLI call per job — no long-lived sessions, so nothing carries over between photos.
async function ask(provider, job, dir) {
  let prompt = job.prompt;
  const args = [];
  let imagePath = null;
  if (job.image) {
    imagePath = path.join(dir, 'photo.jpg');
    fs.writeFileSync(imagePath, Buffer.from(job.image, 'base64'));
  }

  if (provider === 'claude') {
    if (imagePath) prompt = `First look at the photo at ${imagePath} (use the Read tool), then answer.\n\n${prompt}`;
    args.push('-p', prompt, '--model', process.env.CLAUDE_MODEL || 'sonnet', '--output-format', 'text', '--allowedTools', 'Read');
    return run('claude', args, { timeoutMs: TIMEOUT_MS[job.kind], cwd: dir });
  }

  // codex: read-only sandbox, final message written to a file so banners/logs never mix in.
  const outFile = path.join(dir, 'answer.txt');
  args.push('exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', outFile);
  if (imagePath) args.push('--image', imagePath);
  args.push(prompt);
  await run('codex', args, { timeoutMs: TIMEOUT_MS[job.kind], cwd: dir });
  return fs.readFileSync(outFile, 'utf8');
}

async function helper(provider, n) {
  const id = `${provider}-${n}`;
  const dir = path.join(WORK, id);
  fs.mkdirSync(dir, { recursive: true });
  log(id, 'ready');
  let backoff = 1000;

  for (;;) {
    let job;
    try {
      job = await api('/internal/jobs/claim', { provider, worker_id: id });
      backoff = 1000;
    } catch (e) {
      log(id, `can't reach backend (${e.message}); retrying`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    if (!job) continue; // long-poll ended with nothing to do

    const started = Date.now();
    let result;
    try {
      const output = await ask(provider, job, dir);
      result = { ok: true, output };
      log(id, `${job.kind} ${job.id.slice(0, 8)} answered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      result = { ok: false, error: e.message };
      log(id, `${job.kind} ${job.id.slice(0, 8)} failed: ${e.message}`);
    } finally {
      for (const f of ['photo.jpg', 'answer.txt']) fs.rmSync(path.join(dir, f), { force: true });
    }
    try {
      await api(`/internal/jobs/${job.id}/result`, { worker_id: id, ms: Date.now() - started, ...result });
    } catch (e) {
      log(id, `couldn't send result: ${e.message}`);
    }
  }
}

console.log(`Assist helpers → ${API}  (claude ×${COUNTS.claude}, codex ×${COUNTS.codex})`);
for (const [provider, count] of Object.entries(COUNTS)) {
  for (let n = 1; n <= count; n++) helper(provider, n);
}
process.on('SIGTERM', () => { fs.rmSync(WORK, { recursive: true, force: true }); process.exit(0); });
