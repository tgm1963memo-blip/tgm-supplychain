'use strict';

// ตัวเลขหนักของ v_sc_data_confidence (2026-10-20, code review) — นับตอนจบรอบ sync Express แล้วเก็บใน sc_data_counts
// เดิม view นับสดทุกครั้ง (~3.3 วิบน DB จริง: นับบรรทัดออเดอร์ 1.3 ล้าน + SKU กำพร้าใน sales_transactions) และ node:sqlite
// เป็น synchronous → ทุกคำขออื่นต่อคิว จึงเคยแก้ด้วยแคช 5 นาที ซึ่งทำให้เวลา sync ล่าสุด / สถานะ Bplus บน Dashboard ค้างได้ 5 นาที
// ตอนนี้ view อ่านตัวเลขเหล่านี้จากตารางนี้ (ข้อมูลเปลี่ยนเฉพาะตอน sync อยู่แล้ว) ส่วนเวลา sync / สถานะ Bplus / การจอง ยังอ่านสด
function refreshDataCounts(db) {
  const r = db.prepare(`SELECT
      (SELECT COUNT(*) FROM outbound_orders) AS so_count,
      (SELECT COUNT(*) FROM outbound_lines) AS line_count,
      (SELECT COUNT(*) FROM outbound_orders o WHERE NOT EXISTS (SELECT 1 FROM outbound_lines l WHERE l.order_id = o.id)) AS orders_without_line,
      (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t
         WHERE t.sku IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.code = t.sku)) AS orphan_sku_sales_count,
      (SELECT COUNT(DISTINCT t.sku) FROM sales_transactions t
         WHERE t.company = 'CONSI' AND t.sku IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.code = t.sku)) AS orphan_sku_consi_count`).get();
  db.prepare(`INSERT INTO sc_data_counts (id, so_count, line_count, orders_without_line, orphan_sku_sales_count, orphan_sku_consi_count, computed_at)
      VALUES (1, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET so_count = excluded.so_count, line_count = excluded.line_count, orders_without_line = excluded.orders_without_line,
      orphan_sku_sales_count = excluded.orphan_sku_sales_count, orphan_sku_consi_count = excluded.orphan_sku_consi_count, computed_at = excluded.computed_at`)
    .run(r.so_count, r.line_count, r.orders_without_line, r.orphan_sku_sales_count, r.orphan_sku_consi_count);
  return r;
}

module.exports = { refreshDataCounts };
