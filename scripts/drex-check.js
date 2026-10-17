// Sends one made-up event to Drex and prints the raw answer, so you can see the key works.
// Usage (from backend-server):  node scripts/drex-check.js
require('dotenv').config();
const { buildRequest } = require('../services/decisionService');

(async () => {
  if (!process.env.DREX_API_KEY) return console.log('DREX_API_KEY is not set in .env');
  const body = buildRequest({
    firstName: 'Margaret',
    event: '14:10 camera: putting on coat and shoes by the front door (alone)',
    recent: ['13:40 camera: resting in chair', '13:55 camera: walking around'],
    ruleSaysNotify: false,
  });
  const base = (process.env.DREX_BASE_URL || 'https://drex.nace.ai').replace(/\/$/, '');
  const started = Date.now();
  const res = await fetch(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DREX_API_KEY}` },
    body: JSON.stringify(body),
  });
  console.log(`HTTP ${res.status} in ${Date.now() - started} ms`);
  console.log(await res.text());
})();
