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
// Load the face models once at start-up, so the first camera photo isn't slowed by it.
const faces = require('./services/faceService');
if (faces.enabled()) faces.init().catch((e) => console.error('[faces] models failed to load:', e.message));

app.listen(PORT, () => {
  console.log(`backend-server listening on http://localhost:${PORT}`);
});
