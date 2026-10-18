require('dotenv').config();
const app = require('./app');
const journal = require('./services/journalService');
const queue = require('./services/jobQueue');
const scheduler = require('./services/scheduler');

const PORT = process.env.PORT || 3000;

journal.start();
queue.start();
scheduler.start();

app.listen(PORT, () => {
  console.log(`backend-server listening on http://localhost:${PORT}`);
});
