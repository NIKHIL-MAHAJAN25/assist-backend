const prisma = require('../config/prisma');

/**
 * Adds keys to a log entry's JSON payload inside Postgres (payload || patch), instead of
 * read-modify-write in Node. Several steps finish a camera moment at the same time (the decision
 * layer, face recognition); writing the whole payload back would let one wipe out the other.
 */
async function mergePayload(entryId, patch) {
  await prisma.$executeRaw`UPDATE log_entries SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${entryId}`;
}

module.exports = { mergePayload };
