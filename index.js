require('dotenv').config();
const app = require('./app');
const journal = require('./services/journalService');
const queue = require('./services/jobQueue');

const PORT = process.env.PORT || 3000;

journal.start();
queue.start();

app.listen(PORT, () => {
  console.log(`backend-server listening on http://localhost:${PORT}`);
});
