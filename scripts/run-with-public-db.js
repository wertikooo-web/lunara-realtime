// Local dev convenience: `postgres.railway.internal` only resolves inside
// Railway's own network, so local `railway run` needs DATABASE_PUBLIC_URL
// (the public host) in place of DATABASE_URL to reach the same database.
// Usage: railway run --service lunara-realtime -- node scripts/run-with-public-db.js
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
require('../src/server.js');
