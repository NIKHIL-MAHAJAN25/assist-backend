const { runRules } = require('./ruleEngine');
const fallCheck = require('./fallCheck');
const story = require('./storyService');

// The agent acting on its own (Batch C): every 30 s it checks the family's "tell me when…" rules,
// escalates fall checks nobody answered, and sends bedtime stories when it's time.

let running = false;

async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    const hits = await runRules();
    await fallCheck.sweep();
    await story.sweep();
    return { rule_hits: hits };
  } finally {
    running = false;
  }
}

function start() {
  setInterval(() => tick().catch((e) => console.error('[scheduler]', e.message)), 30000).unref();
}

module.exports = { start, tick };
