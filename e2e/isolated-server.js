// No production .env, cron, mail or Express imports. Used by browser regression tests.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { runMigrations } = require('../server/db/migrations');
const { buildApp } = require('../server/app');
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '../server/db/schema.sql'), 'utf8'));
runMigrations(db);
buildApp(db).listen(3980, '127.0.0.1', () => console.log('Isolated test server: 3980'));
