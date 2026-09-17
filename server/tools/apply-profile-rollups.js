const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { migrateCustomerProfileRollups } = require('../db/customerProfileRollups');
const source = process.argv[2];
if (!source || !fs.existsSync(source)) throw new Error('Usage: node server/tools/apply-profile-rollups.js <existing-db>; stop the service after taking a verified backup first');
const db = new DatabaseSync(source);
try {
  db.exec('PRAGMA busy_timeout=30000');
  const totals = () => db.prepare('SELECT COUNT(*) rows,SUM(qty) qty,SUM(amount) amount,SUM(invoice_count) invoice_count FROM v_sales_overview_sales_monthly').get();
  const before = totals();
  migrateCustomerProfileRollups(db);
  const after = totals();
  const { mismatches } = db.prepare('SELECT COUNT(*) mismatches FROM v_sales_overview_sales_monthly r LEFT JOIN customer_profiles cp ON cp.code=r.cust_code WHERE r.category IS NOT cp.category OR r.corporate IS NOT cp.corporate').get();
  if (JSON.stringify(before) !== JSON.stringify(after) || mismatches) throw new Error('Post-migration verification failed');
  console.log(JSON.stringify({ before, after, mismatches, migration: '20260917_customer_profile_rollups_v1' }));
} finally { db.close(); }
