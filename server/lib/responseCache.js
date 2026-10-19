'use strict';

// แคชผลลัพธ์ JSON ของ endpoint ที่คำนวณหนักแต่ข้อมูลเปลี่ยนเฉพาะตอน sync (2026-10-09, ผู้ใช้ขอให้ระบบเร็วขึ้น)
// วัดจริงบน DB จริง: /api/dashboard/exec 0.6–1.5 วิ, /api/dashboard_sales_summary 2–4.6 วิ, v_sc_data_confidence 0.5 วิ ต่อครั้ง
// แคชแยกตาม URL + ผู้ใช้/สิทธิ์ (ผลลัพธ์ขึ้นกับ scope ของผู้ใช้ — lib/customerScope.js) · เฉพาะ GET ที่ตอบ 200
// version = แถวล่าสุดของ sync_log (เปลี่ยนตอนเริ่มและตอนจบทุกรอบ sync) + ไฟล์ห้อง SKU + การแก้กลุ่มลูกค้า/ผู้ใช้/ทีมขาย
// → ข้อมูลเปลี่ยนเมื่อไร แคชหมดอายุทันที · ttlMs กันค่าค้างกรณีมีการเปลี่ยนที่ version มองไม่เห็น (เช่นลบแถว)
function dataVersion(db) {
  try {
    const s = db.prepare('SELECT id, finished_at FROM sync_log ORDER BY id DESC LIMIT 1').get() || {};
    const one = (sql) => db.prepare(sql).get()?.v || '';
    return [s.id, s.finished_at,
      one('SELECT MAX(synced_at) AS v FROM sync_file_state'),
      one('SELECT MAX(updated_at) AS v FROM customer_profiles'),
      one('SELECT MAX(updated_at) AS v FROM sc_users'),
      one('SELECT MAX(updated_at) AS v FROM approval_workflow_templates')].join('|');
  } catch {
    return null; // อ่าน version ไม่ได้ = ไม่ใช้แคช
  }
}

// perUser: false = ผลลัพธ์ไม่ขึ้นกับสิทธิ์ผู้ใช้ (เช่น v_sc_data_confidence ที่นับทั้งระบบ) → ใช้แคชก้อนเดียวร่วมกันทุกคน
function cacheJson(db, { ttlMs = 15 * 60 * 1000, max = 200, versioned = true, perUser = true } = {}) {
  const store = new Map();
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const version = versioned ? dataVersion(db) : '';
    if (version === null) return next();
    const u = req.user || {};
    const key = perUser
      ? JSON.stringify([req.originalUrl, u.uid, u.role, u.slm_codes || '', u.bplus_codes || '', u.department || ''])
      : req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.version === version && Date.now() - hit.at < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.json(hit.body);
    }
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        store.delete(key);
        store.set(key, { version, at: Date.now(), body });
        while (store.size > max) store.delete(store.keys().next().value);
      }
      return send(body);
    };
    next();
  };
}

module.exports = { cacheJson, dataVersion };
