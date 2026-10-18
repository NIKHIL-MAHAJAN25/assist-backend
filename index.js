require('dotenv').config();
const app = require('./app');
const journal = require('./services/journalService');
const queue = require('./services/jobQueue');
const scheduler = require('./services/scheduler');

const PORT = process.env.PORT || 3000;

journal.start();
queue.start();
scheduler.start();
// Make the fixed phrases (fall check, guide home) ahead of time so urgent ones never wait on TTS.
require('./config/prisma').patient.findMany({ select: { name: true } })
  .then((pts) => require('./services/voiceService').warmUp(pts))
  .catch((e) => console.error('[tts warm-up]', e.message));

app.listen(PORT, () => {
  console.log(`backend-server listening on http://localhost:${PORT}`);
});
