'use strict';

// Runs once, atomically. Triggers also cover imports outside the HTTP API.
function migrateCustomerProfileRollups(db) {
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const id = '20260917_customer_profile_rollups_v1';
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(id)) {
      db.exec('COMMIT');
      return;
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sales_ov_cust_code ON v_sales_overview_sales_monthly(cust_code);
      CREATE TRIGGER customer_profile_rollup_insert AFTER INSERT ON customer_profiles BEGIN
        UPDATE v_sales_overview_sales_monthly SET category=NEW.category, corporate=NEW.corporate
        WHERE cust_code=NEW.code AND (category IS NOT NEW.category OR corporate IS NOT NEW.corporate);
      END;
      CREATE TRIGGER customer_profile_rollup_update AFTER UPDATE OF code,category,corporate ON customer_profiles
      WHEN OLD.code IS NOT NEW.code OR OLD.category IS NOT NEW.category OR OLD.corporate IS NOT NEW.corporate BEGIN
        UPDATE v_sales_overview_sales_monthly SET category=NULL, corporate=NULL
        WHERE cust_code=OLD.code AND OLD.code IS NOT NEW.code;
        UPDATE v_sales_overview_sales_monthly SET category=NEW.category, corporate=NEW.corporate
        WHERE cust_code=NEW.code AND (category IS NOT NEW.category OR corporate IS NOT NEW.corporate);
      END;
      CREATE TRIGGER customer_profile_rollup_delete AFTER DELETE ON customer_profiles BEGIN
        UPDATE v_sales_overview_sales_monthly SET category=NULL, corporate=NULL WHERE cust_code=OLD.code;
      END;
      UPDATE v_sales_overview_sales_monthly AS r SET
        category=(SELECT category FROM customer_profiles WHERE code=r.cust_code),
        corporate=(SELECT corporate FROM customer_profiles WHERE code=r.cust_code)
      WHERE category IS NOT (SELECT category FROM customer_profiles WHERE code=r.cust_code)
         OR corporate IS NOT (SELECT corporate FROM customer_profiles WHERE code=r.cust_code);
    `);
    db.prepare('INSERT INTO app_migrations(id) VALUES (?)').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrateCustomerProfileRollups };
