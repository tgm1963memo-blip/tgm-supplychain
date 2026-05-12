/**
 * TGM Supply Chain — Step 3: Supabase DB Adapter
 * ================================================
 * ไฟล์นี้แทนที่ DB.get()/DB.set() ใน Supply Chain v3
 * ให้ copy โค้ดนี้ไปวางไว้ใน <script> ของ HTML
 * ก่อน function อื่นๆ ทั้งหมด
 *
 * วิธีใช้:
 *   แทน DB.get('forecasts')     → await SB.get('forecasts')
 *   แทน DB.set('forecasts', fc) → await SB.set('forecasts', fc)
 *   แทน DB.get('stock')         → await SB.stock()
 */

// ============================================================
// CONFIG — แก้ค่านี้
// ============================================================
const SUPABASE_URL = 'https://XXXXXX.supabase.co';   // ← แก้
const SUPABASE_ANON_KEY = 'eyJh...';                  // ← anon key

// ============================================================
// INIT SUPABASE CLIENT
// ============================================================
// เพิ่มใน <head>:
// <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 10 } }
});

// ============================================================
// CURRENT USER (จาก login)
// ============================================================
let CURRENT_USER = null;  // set ตอน doLogin()

// ============================================================
// SB — Supabase Adapter แทน DB
// ============================================================
const SB = {

  // ── USERS ──────────────────────────────────────────────

  async login(uid, pwd) {
    // ดึง user จาก Supabase (pwd check ที่ app layer)
    const { data, error } = await _sb
      .from('sc_users')
      .select('uid, name, role, slm_id, email, pwd_hash, is_active')
      .eq('uid', uid)
      .eq('is_active', true)
      .single();

    if (error || !data) return null;
    if (data.pwd_hash !== pwd) return null;  // TODO: bcrypt compare
    return data;
  },

  async getUsers() {
    const { data } = await _sb.from('v_sc_users_safe').select('*').order('uid');
    return data || [];
  },

  async upsertUser(user) {
    const { data, error } = await _sb.from('sc_users').upsert(user);
    return { data, error };
  },

  // ── PRODUCTS ───────────────────────────────────────────

  async getProducts(activeOnly = true) {
    let q = _sb.from('products').select('*').order('code');
    if (activeOnly) q = q.eq('is_active', true);
    const { data } = await q;
    return data || [];
  },

  // ── SALES HISTORY ──────────────────────────────────────

  async getSalesHistory(slmId = 'ALL', months = 4) {
    // ดึง N เดือนล่าสุด
    const startYm = new Date();
    startYm.setMonth(startYm.getMonth() - months);
    const startStr = startYm.toISOString().substring(0, 7);  // 'YYYY-MM'

    const { data } = await _sb
      .from('sales_history')
      .select('sku, ym, qty')
      .eq('slm_id', slmId)
      .gte('ym', startStr)
      .order('sku')
      .order('ym');

    // จัดรูปแบบให้เหมือน ALL_HIST เดิม: {skuCode: {monthly: {ym: qty}, avg3: N}}
    const result = {};
    for (const row of (data || [])) {
      if (!result[row.sku]) {
        result[row.sku] = { name: '', monthly: {}, avg3: 0 };
      }
      result[row.sku].monthly[row.ym] = row.qty;
    }

    // คำนวณ avg3 (เฉลี่ย 3 เดือนล่าสุด)
    const last3 = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - 1 - i);
      last3.push(d.toISOString().substring(0, 7));
    }
    for (const sku in result) {
      const vals = last3.map(m => result[sku].monthly[m] || 0).filter(v => v > 0);
      result[sku].avg3 = vals.length > 0
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : 0;
    }

    return result;
  },

  // ── FORECASTS ──────────────────────────────────────────

  async getForecasts(filters = {}) {
    let q = _sb.from('forecasts').select(`
      id, created_by, slm_id, sku, cust_code, qty, deliv_date,
      note, is_approved, approved_by, approved_at, edited_by, created_at
    `).order('created_at', { ascending: false });

    if (filters.slm_id)     q = q.eq('slm_id', filters.slm_id);
    if (filters.sku)        q = q.eq('sku', filters.sku);
    if (filters.approved !== undefined) q = q.eq('is_approved', filters.approved);

    const { data, error } = await q;
    if (error) { console.error('getForecasts:', error); return []; }

    // แปลง field names ให้ตรงกับ HTML เดิม
    return (data || []).map(f => ({
      id:          f.id,
      by:          f.slm_id || f.created_by,
      slm_id:      f.slm_id,
      sku:         f.sku,
      custCode:    f.cust_code,
      qty:         f.qty,
      delivDate:   f.deliv_date,
      note:        f.note,
      approved:    f.is_approved,
      approved_by: f.approved_by,
      ts:          new Date(f.created_at).getTime(),
      edited_by:   f.edited_by,
    }));
  },

  async addForecast(fc) {
    const row = {
      id:          fc.id || genId('FC'),
      created_by:  fc.by || CURRENT_USER?.uid,
      slm_id:      fc.by || CURRENT_USER?.slm_id,
      sku:         fc.sku,
      cust_code:   fc.custCode || null,
      qty:         fc.qty,
      deliv_date:  fc.delivDate || null,
      note:        fc.note || null,
      is_approved: false,
      edited_by:   CURRENT_USER?.uid,
    };
    const { data, error } = await _sb.from('forecasts').insert(row).select().single();
    if (error) { console.error('addForecast:', error); return null; }
    return data;
  },

  async addForecasts(fcList) {
    const rows = fcList.map(fc => ({
      id:          fc.id || genId('FC'),
      created_by:  fc.by || CURRENT_USER?.uid,
      slm_id:      fc.by || CURRENT_USER?.slm_id,
      sku:         fc.sku,
      cust_code:   fc.custCode || null,
      qty:         fc.qty,
      deliv_date:  fc.delivDate || null,
      note:        fc.note || null,
      is_approved: false,
      edited_by:   CURRENT_USER?.uid,
    }));
    const { error } = await _sb.from('forecasts').insert(rows);
    if (error) { console.error('addForecasts:', error); }
    return !error;
  },

  async approveForecasts(ids) {
    const { error } = await _sb.from('forecasts')
      .update({ is_approved: true, approved_by: CURRENT_USER?.uid, approved_at: new Date().toISOString() })
      .in('id', ids);
    return !error;
  },

  // ── PO PLANS ────────────────────────────────────────────

  async getPOPlans(filters = {}) {
    let q = _sb.from('po_plans').select('*').order('created_at', { ascending: false });
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.sku)    q = q.eq('sku', filters.sku);
    const { data } = await q;
    return (data || []).map(p => ({
      id:        p.id,
      sku:       p.sku,
      skuName:   '',  // join ใน app layer
      qty:       p.qty,
      delivDate: p.deliv_date,
      customer:  p.customer,
      branch:    p.branch,
      status:    p.status,
      so:        p.so_ref,
      note:      p.note,
      by:        p.created_by,
      ver:       p.version,
      ts:        new Date(p.created_at).getTime(),
    }));
  },

  async upsertPOPlan(po) {
    const row = {
      id:          po.id,
      sku:         po.sku,
      qty:         po.qty,
      deliv_date:  po.delivDate,
      customer:    po.customer,
      cust_code:   po.custCode || null,
      branch:      po.branch,
      status:      po.status || 'pending',
      so_ref:      po.so || null,
      note:        po.note || null,
      version:     (po.ver || 1) + 1,
      created_by:  po.by || CURRENT_USER?.uid,
      edited_by:   CURRENT_USER?.uid,
    };
    const { error } = await _sb.from('po_plans').upsert(row);
    return !error;
  },

  // ── STOCK (Read from WMS Supabase) ──────────────────────

  async getStock() {
    const { data } = await _sb.from('stock').select('sku, qty, unit, last_updated');
    const result = {};
    for (const s of (data || [])) {
      result[s.sku] = { qty: s.qty, unit: s.unit };
    }
    return result;
  },

  async getStockLots(sku = null) {
    let q = _sb.from('stock_lots').select('*').order('exp_date');
    if (sku) q = q.eq('sku', sku);
    const { data } = await q;
    return data || [];
  },

  async getStockPlanning() {
    // ใช้ view ที่ join stock + sales_history
    const { data } = await _sb.from('v_stock_planning').select('*').order('days_remaining');
    return data || [];
  },

  // ── RESERVATIONS ────────────────────────────────────────

  async getReservations(status = null) {
    let q = _sb.from('v_reservation_status').select('*').order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data } = await q;
    return data || [];
  },

  async addReservation(res) {
    const { data, error } = await _sb.from('reservations').insert({
      sku:           res.sku,
      qty_requested: res.qty,
      cust_code:     res.custCode || null,
      cust_name:     res.custName || null,
      need_date:     res.needDate || null,
      requested_by:  CURRENT_USER?.uid,
      note:          res.note || null,
      ref_forecast_id: res.forecastId || null,
    }).select().single();
    if (error) { console.error('addReservation:', error); return null; }
    return data;
  },

  async approveReservation(id, qtyApproved) {
    const { error } = await _sb.from('reservations').update({
      status:       'approved',
      qty_approved: qtyApproved,
      approved_by:  CURRENT_USER?.uid,
      approved_at:  new Date().toISOString(),
    }).eq('id', id);
    return !error;
  },

  // ── SKU SETTINGS ────────────────────────────────────────

  async getSkuSettings() {
    const { data } = await _sb.from('sku_settings').select('*');
    const result = {};
    for (const s of (data || [])) {
      result[s.sku] = {
        min_stock:  s.min_stock,
        shelf_life: s.shelf_life,
        moq:        s.moq,
        lt:         s.lead_time,
        note:       s.note,
      };
    }
    return result;
  },

  async updateSkuSetting(sku, settings) {
    const { error } = await _sb.from('sku_settings').upsert({
      sku,
      min_stock:  settings.min_stock,
      shelf_life: settings.shelf_life,
      moq:        settings.moq,
      lead_time:  settings.lt || settings.lead_time,
      note:       settings.note,
      updated_by: CURRENT_USER?.uid,
    });
    return !error;
  },

  // ── AUDIT LOG ────────────────────────────────────────────

  async audit(action, target, detail = {}) {
    if (!CURRENT_USER) return;
    await _sb.from('audit_log').insert({
      uid:    CURRENT_USER.uid,
      role:   CURRENT_USER.role,
      action,
      target: String(target),
      detail,
    });
  },

  async getAuditLog(limit = 200) {
    const { data } = await _sb
      .from('audit_log')
      .select('*')
      .order('ts', { ascending: false })
      .limit(limit);
    return (data || []).map(l => ({
      ts:     l.ts,
      uid:    l.uid,
      role:   l.role,
      action: l.action,
      target: l.target,
      detail: l.detail || {},
    }));
  },

  // ── REALTIME ─────────────────────────────────────────────

  subscribeStock(callback) {
    return _sb.channel('stock-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock' }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_lots' }, callback)
      .subscribe();
  },

  subscribeReservations(callback) {
    return _sb.channel('reservation-changes')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reservations' }, callback)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reservations' }, callback)
      .subscribe();
  },

  subscribeForecasts(callback) {
    return _sb.channel('forecast-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forecasts' }, callback)
      .subscribe();
  },
};

// ============================================================
// CACHE LAYER (ลด round trips)
// ============================================================
const CACHE = {
  _data: {},
  _ts: {},
  TTL: 60 * 1000,  // 60 วินาที

  async get(key, fetcher) {
    const now = Date.now();
    if (this._data[key] && (now - (this._ts[key] || 0)) < this.TTL) {
      return this._data[key];
    }
    const data = await fetcher();
    this._data[key] = data;
    this._ts[key] = now;
    return data;
  },

  invalidate(key) {
    delete this._data[key];
    delete this._ts[key];
  },

  invalidateAll() {
    this._data = {};
    this._ts = {};
  },
};

// Cached getters (ใช้ใน UI)
const DB_SB = {
  async products()    { return CACHE.get('products',    () => SB.getProducts()); },
  async skuSettings() { return CACHE.get('sku_settings', () => SB.getSkuSettings()); },
  async stock()       { return CACHE.get('stock',       () => SB.getStock()); },
  async stockLots()   { return CACHE.get('stock_lots',  () => SB.getStockLots()); },

  // ไม่ cache เพราะอัปเดตบ่อย
  async forecasts(filters)    { return SB.getForecasts(filters); },
  async poPlans(filters)      { return SB.getPOPlans(filters); },
  async reservations(status)  { return SB.getReservations(status); },
  async auditLog(limit)       { return SB.getAuditLog(limit); },
  async users()               { return SB.getUsers(); },

  async salesHistory(slmId, months) {
    const key = `hist_${slmId}_${months}`;
    return CACHE.get(key, () => SB.getSalesHistory(slmId, months));
  },
};

// ============================================================
// MIGRATION HELPERS
// ============================================================

/**
 * ย้าย localStorage → Supabase ครั้งเดียว
 * เรียกตอน login ครั้งแรกหลัง migrate
 */
async function migrateLocalStorage() {
  const lsKeys = ['forecasts', 'po_log', 'audit_log'];

  for (const key of lsKeys) {
    const raw = localStorage.getItem('tgm3_' + key);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data) || data.length === 0) continue;

      if (key === 'forecasts') {
        await SB.addForecasts(data);
        console.log(`✓ Migrated ${data.length} forecasts from localStorage`);
      }
      // TODO: migrate po_log, audit_log

      // mark เป็น migrated
      localStorage.setItem('tgm3_migrated_' + key, '1');
      localStorage.removeItem('tgm3_' + key);
    } catch (e) {
      console.error(`Migration error for ${key}:`, e);
    }
  }
}

// ============================================================
// UPDATED doLogin() — แทนที่ของเดิม
// ============================================================
async function doLogin() {
  const uid = document.getElementById('l-uid').value.trim();
  const pwd = document.getElementById('l-pwd').value;

  const user = await SB.login(uid, pwd);
  if (!user) {
    document.getElementById('l-err').textContent = 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง';
    return;
  }

  // Set globals
  CURRENT_USER = user;
  ROLE  = user.role;
  UID   = user.uid;
  UNAME = user.name;

  // Migrate localStorage → Supabase (ครั้งแรก)
  if (!localStorage.getItem('tgm3_migrated_forecasts')) {
    await migrateLocalStorage();
  }

  // Subscribe realtime
  SB.subscribeStock(() => {
    CACHE.invalidate('stock');
    CACHE.invalidate('stock_lots');
    // ถ้าหน้า Stock Planning เปิดอยู่ ให้ refresh
    if (document.getElementById('ps-tbl')) planStkT();
  });

  SB.subscribeReservations((payload) => {
    toast('📦 มีการจองสินค้าใหม่: ' + payload.new?.sku);
  });

  // Audit login
  await SB.audit('LOGIN', 'system', { role: ROLE });

  // แสดง app
  document.getElementById('ls').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  buildSB();
  nav('dash');
}

// ============================================================
// UPDATED pgForecast() — ใช้ SB แทน DB
// ============================================================
async function pgForecast_SB() {
  document.getElementById('ct').innerHTML = `
    <div style="text-align:center;padding:40px;color:var(--TX3)">
      <div style="font-size:14px">กำลังโหลด...</div>
    </div>`;

  const isAll  = ROLE !== 'sales';
  const fc     = await SB.getForecasts(isAll ? {} : { slm_id: CURRENT_USER?.slm_id });
  const prods  = await DB_SB.products();
  const prodMap = Object.fromEntries(prods.map(p => [p.code, p]));

  // enrichment
  fc.forEach(f => {
    const p = prodMap[f.sku];
    f.skuName = p?.name || f.sku;
    f.leadTime = p?.lead_time || 7;
  });

  // render (เหมือน fcT() เดิม แต่ใช้ข้อมูลจาก Supabase)
  document.getElementById('ct').innerHTML = `
    <div class="card">
      <div class="ch">
        <div class="ct2">Paste Forecast จาก Excel (Ctrl+V)</div>
      </div>
      <div class="pz" onclick="document.getElementById('fc-pi').focus()">
        <b>คลิกแล้ว Ctrl+V</b>
        <span style="font-size:12px">รูปแบบ: รหัสสินค้า | รหัสลูกค้า | จำนวน | วันที่ | หมายเหตุ</span>
        <textarea id="fc-pi" style="position:absolute;opacity:0;pointer-events:none"
          onpaste="handleFcPaste_SB(event)"></textarea>
      </div>
      <div id="fc-pv"></div>
    </div>
    <div class="card">
      <div class="ch">
        <div class="ct2">รายการ Forecast (${fc.length} รายการ)</div>
        <div style="display:flex;gap:8px">
          ${isAll ? `<select class="btn btn-sm" id="fc-sf" onchange="pgForecast_SB()">
            <option value="">ทุก Sales</option>
          </select>` : ''}
          <button class="btn btn-sm btn-p" onclick="showFcModal()">+ เพิ่ม</button>
          <button class="btn btn-sm btn-g" onclick="expFC_SB()">Export</button>
        </div>
      </div>
      ${renderForecastTable(fc, isAll)}
    </div>`;
}

function renderForecastTable(fc, isAll) {
  const today = new Date();
  if (!fc.length) return '<p style="padding:16px;color:var(--TX3)">ยังไม่มีข้อมูล</p>';

  return `<div class="tw"><table>
    <thead><tr>
      <th>Sales</th><th>SKU</th><th>ชื่อสินค้า</th>
      <th style="text-align:right">จำนวน</th>
      <th>วันต้องการ</th><th>วันต้องสั่ง</th>
      <th>สถานะ</th><th>หมายเหตุ</th>
      ${isAll ? '<th>อนุมัติ</th>' : ''}
    </tr></thead>
    <tbody>
    ${fc.map(f => {
      const od = f.delivDate
        ? new Date(new Date(f.delivDate).getTime() - f.leadTime * 864e5)
        : null;
      const late = od && od < today;
      return `<tr style="${late ? 'background:#FEF3F2' : ''}">
        <td class="mono">${f.by}</td>
        <td class="mono">${f.sku}</td>
        <td>${(f.skuName || '').substring(0, 28)}</td>
        <td style="text-align:right;font-weight:700">${Math.round(f.qty).toLocaleString()}</td>
        <td>${f.delivDate ? new Date(f.delivDate).toLocaleDateString('th-TH',{day:'2-digit',month:'short'}) : '—'}</td>
        <td style="${late ? 'color:var(--R);font-weight:700' : ''}">
          ${od ? od.toLocaleDateString('th-TH',{day:'2-digit',month:'short'}) : '—'}
        </td>
        <td>${late ? '<span class="badge bbr">สั่งด่วน</span>' : '<span class="badge bbg">ปกติ</span>'}</td>
        <td style="font-size:12px;color:var(--TX2)">${f.note || ''}</td>
        ${isAll ? `<td>${f.approved
          ? '<span class="badge bbg">✓</span>'
          : `<button class="btn btn-xs btn-g" onclick="approveFC_SB('${f.id}')">อนุมัติ</button>`
        }</td>` : ''}
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

async function approveFC_SB(id) {
  await SB.approveForecasts([id]);
  await SB.audit('APPROVE_FC', id, {});
  toast('อนุมัติ Forecast สำเร็จ');
  pgForecast_SB();
}

async function handleFcPaste_SB(e) {
  e.preventDefault();
  const rows = e.clipboardData.getData('text').trim().split('\n').map(r => r.split('\t'));
  const imp = rows
    .filter(r => r.length >= 3 && r[0] && r[2])
    .map(r => ({
      id: genId('FC'),
      by: UID,
      sku: r[0].trim(),
      custCode: r[1]?.trim() || '',
      qty: parseFloat(r[2]) || 0,
      delivDate: r[3]?.trim() || '',
      note: r[4]?.trim() || '',
    }))
    .filter(f => f.qty > 0);

  const pv = document.getElementById('fc-pv');
  if (!imp.length) { pv.innerHTML = '<div class="al alw">ไม่พบข้อมูล</div>'; return; }

  pv.innerHTML = `<div class="al als">พบ ${imp.length} รายการ
    <button class="btn btn-sm btn-p" onclick="confirmFcPaste_SB()">นำเข้าทั้งหมด</button>
  </div>`;
  window._fcp = imp;
}

async function confirmFcPaste_SB() {
  const imp = window._fcp || [];
  const ok = await SB.addForecasts(imp);
  if (ok) {
    await SB.audit('PASTE_FC', 'forecast', { count: imp.length });
    document.getElementById('fc-pv').innerHTML =
      `<div class="al als">✓ นำเข้าสำเร็จ ${imp.length} รายการ</div>`;
    setTimeout(pgForecast_SB, 1000);
  } else {
    document.getElementById('fc-pv').innerHTML =
      '<div class="al ald">เกิดข้อผิดพลาด กรุณาลองใหม่</div>';
  }
}

async function expFC_SB() {
  const fc = await SB.getForecasts();
  toXLSX([['Forecast',
    ['Sales','รหัสสินค้า','ชื่อสินค้า','จำนวน','วันต้องการ','หมายเหตุ','อนุมัติ'],
    fc.map(f => [f.by, f.sku, f.skuName || '', f.qty, f.delivDate || '', f.note || '', f.approved ? 'Y' : 'N'])
  ]], 'Forecast_' + todayStr() + '.xlsx');
}
