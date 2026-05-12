/**
 * ════════════════════════════════════════════════
 * TGM Supply Chain — SUPABASE ADAPTER v1.0
 * ════════════════════════════════════════════════
 * วิธีใช้: Copy ทั้งไฟล์นี้ วางใน index.html
 * ตำแหน่ง: หลัง <script> แรก ก่อน const MONTHS=[...]
 *
 * แก้ค่า 2 บรรทัดข้างล่างก่อนใช้งาน
 * ════════════════════════════════════════════════
 */

// ── CONFIG (แก้ค่านี้) ────────────────────────────────────────────
const SUPABASE_URL      = 'https://wjhqvjlcshwnrukbdlgr.supabase.co';   // ← Project URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndqaHF2amxjc2h3bnJ1a2JkbGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTg4MDcsImV4cCI6MjA5MzQ5NDgwN30.5Px3wsyf4DtZL6TfMqaF5uyTBNo8axrmdbOrZsuYIMY'; // ← anon key

// ── INIT ──────────────────────────────────────────────────────────
// ต้องมี <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
// วางใน <head> ก่อน script block นี้
const _sbc = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── CURRENT SESSION ────────────────────────────────────────────────
let CURRENT_USER = null; // เซ็ตตอน doLogin()

// ════════════════════════════════════════════════
// SB — Supabase API Wrapper
// ════════════════════════════════════════════════
const SB = {

  // ──────────────────────────────
  // AUTH
  // ──────────────────────────────
  async login(uid, pwd) {
    const { data, error } = await _sbc
      .from('sc_users')
      .select('uid,name,role,slm_id,email,pwd_hash,is_active')
      .eq('uid', uid)
      .eq('is_active', true)
      .single();
    if (error || !data)        return null;
    if (data.pwd_hash !== pwd) return null;
    return data;
  },

  async getUsers() {
    const { data } = await _sbc
      .from('v_sc_users_safe')
      .select('*')
      .order('uid');
    return data || [];
  },

  async upsertUser(u) {
    return _sbc.from('sc_users').upsert(u);
  },

  // ──────────────────────────────
  // PRODUCTS / SKU
  // ──────────────────────────────
  async getProducts() {
    const { data } = await _sbc
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('code');
    return data || [];
  },

  // ──────────────────────────────
  // SALES HISTORY
  // ──────────────────────────────
  async getSalesHistory(slmId = 'ALL') {
    // ดึง 4 เดือนล่าสุด
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 4);
    const startYm = cutoff.toISOString().slice(0, 7);

    const { data } = await _sbc
      .from('sales_history')
      .select('sku, ym, qty')
      .eq('slm_id', slmId)
      .gte('ym', startYm)
      .order('sku').order('ym');

    // แปลงเป็น format เดิม {skuCode: {name:'', monthly:{}, avg3:0}}
    const result = {};
    for (const row of (data || [])) {
      if (!result[row.sku]) result[row.sku] = { name: '', monthly: {}, avg3: 0 };
      result[row.sku].monthly[row.ym] = row.qty;
    }

    // คำนวณ avg3
    for (const sku in result) {
      const months3 = [];
      for (let i = 1; i <= 3; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        months3.push(d.toISOString().slice(0, 7));
      }
      const vals = months3.map(m => result[sku].monthly[m] || 0).filter(v => v > 0);
      result[sku].avg3 = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
    return result;
  },

  // ──────────────────────────────
  // FORECASTS
  // ──────────────────────────────
  async getForecasts(slmId = null) {
    let q = _sbc
      .from('forecasts')
      .select('id,created_by,slm_id,sku,cust_code,qty,deliv_date,note,is_approved,approved_by,edited_by,created_at')
      .order('created_at', { ascending: false });
    if (slmId) q = q.eq('slm_id', slmId);
    const { data } = await q;
    return (data || []).map(f => ({
      id:        f.id,
      by:        f.slm_id || f.created_by,
      sku:       f.sku,
      custCode:  f.cust_code,
      qty:       f.qty,
      delivDate: f.deliv_date,
      note:      f.note,
      approved:  f.is_approved,
      edited_by: f.edited_by,
      ts:        new Date(f.created_at).getTime(),
    }));
  },

  async addForecast(fc) {
    return _sbc.from('forecasts').insert({
      id:          fc.id,
      created_by:  CURRENT_USER?.uid,
      slm_id:      fc.by || CURRENT_USER?.slm_id,
      sku:         fc.sku,
      cust_code:   fc.custCode || null,
      qty:         fc.qty,
      deliv_date:  fc.delivDate || null,
      note:        fc.note || null,
      edited_by:   CURRENT_USER?.uid,
    });
  },

  async addForecasts(fcList) {
    const rows = fcList.map(fc => ({
      id:         fc.id,
      created_by: CURRENT_USER?.uid,
      slm_id:     fc.by || CURRENT_USER?.slm_id,
      sku:        fc.sku,
      cust_code:  fc.custCode || null,
      qty:        fc.qty,
      deliv_date: fc.delivDate || null,
      note:       fc.note || null,
      edited_by:  CURRENT_USER?.uid,
    }));
    const { error } = await _sbc.from('forecasts').insert(rows);
    return !error;
  },

  async approveForecast(id) {
    return _sbc.from('forecasts').update({
      is_approved: true,
      approved_by: CURRENT_USER?.uid,
      approved_at: new Date().toISOString(),
    }).eq('id', id);
  },

  // ──────────────────────────────
  // PO PLANS
  // ──────────────────────────────
  async getPOPlans() {
    const { data } = await _sbc
      .from('po_plans')
      .select('*')
      .order('created_at', { ascending: false });
    return (data || []).map(p => ({
      id:        p.id,
      sku:       p.sku,
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

  async upsertPO(po) {
    return _sbc.from('po_plans').upsert({
      id:         po.id,
      sku:        po.sku,
      qty:        po.qty,
      deliv_date: po.delivDate,
      customer:   po.customer,
      branch:     po.branch,
      status:     po.status || 'pending',
      so_ref:     po.so || null,
      note:       po.note || null,
      version:    (po.ver || 1) + 1,
      created_by: po.by || CURRENT_USER?.uid,
      edited_by:  CURRENT_USER?.uid,
    });
  },

  // ──────────────────────────────
  // STOCK (WMS writes, SC reads)
  // ──────────────────────────────
  async getStock() {
    const { data } = await _sbc.from('stock').select('sku,qty,unit,last_updated');
    const result = {};
    for (const s of (data || [])) result[s.sku] = { qty: s.qty, unit: s.unit };
    return result;
  },

  async getStockLots(sku = null) {
    let q = _sbc.from('stock_lots').select('*').order('exp_date');
    if (sku) q = q.eq('sku', sku);
    const { data } = await q;
    return data || [];
  },

  async getStockPlanning() {
    const { data } = await _sbc
      .from('v_stock_planning')
      .select('*')
      .order('days_remaining');
    return data || [];
  },

  // ──────────────────────────────
  // RESERVATIONS
  // ──────────────────────────────
  async getReservations(status = null) {
    let q = _sbc
      .from('v_reservation_status')
      .select('*')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data } = await q;
    return data || [];
  },

  async addReservation(res) {
    const { data } = await _sbc.from('reservations').insert({
      sku:           res.sku,
      qty_requested: res.qty,
      cust_code:     res.custCode || null,
      cust_name:     res.custName || null,
      need_date:     res.needDate || null,
      requested_by:  CURRENT_USER?.uid,
      note:          res.note || null,
    }).select().single();
    return data;
  },

  async approveReservation(id, qty) {
    return _sbc.from('reservations').update({
      status:       'approved',
      qty_approved: qty,
      approved_by:  CURRENT_USER?.uid,
      approved_at:  new Date().toISOString(),
    }).eq('id', id);
  },

  // ──────────────────────────────
  // SKU SETTINGS
  // ──────────────────────────────
  async getSkuSettings() {
    const { data } = await _sbc.from('sku_settings').select('*');
    const result = {};
    for (const s of (data || [])) {
      result[s.sku] = { min_stock: s.min_stock, shelf_life: s.shelf_life, moq: s.moq, lt: s.lead_time, note: s.note };
    }
    return result;
  },

  async updateSkuSetting(sku, settings) {
    return _sbc.from('sku_settings').upsert({
      sku,
      min_stock:  settings.min_stock,
      shelf_life: settings.shelf_life,
      moq:        settings.moq,
      lead_time:  settings.lt,
      note:       settings.note,
      updated_by: CURRENT_USER?.uid,
    });
  },

  // ──────────────────────────────
  // AUDIT LOG
  // ──────────────────────────────
  async audit(action, target, detail = {}) {
    if (!CURRENT_USER) return;
    await _sbc.from('audit_log').insert({
      uid:    CURRENT_USER.uid,
      role:   CURRENT_USER.role,
      action,
      target: String(target),
      detail,
    });
  },

  async getAuditLog(limit = 200) {
    const { data } = await _sbc
      .from('audit_log')
      .select('*')
      .order('ts', { ascending: false })
      .limit(limit);
    return data || [];
  },

  // ──────────────────────────────
  // REALTIME SUBSCRIPTIONS
  // ──────────────────────────────
  subscribeStock(cb) {
    return _sbc.channel('stock-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock_lots' }, cb)
      .subscribe();
  },

  subscribeReservations(cb) {
    return _sbc.channel('reservations-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reservations' }, cb)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'reservations' }, cb)
      .subscribe();
  },

  subscribeForecasts(cb) {
    return _sbc.channel('forecasts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'forecasts' }, cb)
      .subscribe();
  },
};

// ════════════════════════════════════════════════
// CACHE — ลด API calls ที่ไม่จำเป็น
// ════════════════════════════════════════════════
const CACHE = {
  _store: {},
  _time:  {},
  TTL: 60000, // 60 วินาที

  async get(key, fetcher) {
    if (this._store[key] && Date.now() - (this._time[key] || 0) < this.TTL)
      return this._store[key];
    const data = await fetcher();
    this._store[key] = data;
    this._time[key]  = Date.now();
    return data;
  },

  clear(key) { delete this._store[key]; delete this._time[key]; },
  clearAll()  { this._store = {}; this._time = {}; },
};

// ════════════════════════════════════════════════
// MIGRATION — ย้าย localStorage → Supabase ครั้งแรก
// ════════════════════════════════════════════════
async function migrateFromLocalStorage() {
  const migrated = localStorage.getItem('tgm_sb_migrated');
  if (migrated) return; // ย้ายแล้ว

  console.log('[Migration] ตรวจสอบ localStorage...');

  // ย้าย forecasts
  const fcRaw = localStorage.getItem('tgm3_forecasts');
  if (fcRaw) {
    try {
      const fc = JSON.parse(fcRaw);
      if (fc.length > 0) {
        await SB.addForecasts(fc);
        console.log(`[Migration] ✓ ย้าย ${fc.length} forecasts`);
      }
    } catch (e) { console.error('[Migration] forecast error:', e); }
  }

  // ย้าย po_log
  const poRaw = localStorage.getItem('tgm3_po_log');
  if (poRaw) {
    try {
      const pos = JSON.parse(poRaw);
      for (const po of pos) await SB.upsertPO(po);
      console.log(`[Migration] ✓ ย้าย ${pos.length} PO plans`);
    } catch (e) { console.error('[Migration] PO error:', e); }
  }

  localStorage.setItem('tgm_sb_migrated', '1');
  console.log('[Migration] ✓ เสร็จสมบูรณ์');
}

// ════════════════════════════════════════════════
// doLogin() — แทนที่ของเดิม
// ════════════════════════════════════════════════
async function doLogin() {
  const uid = document.getElementById('l-uid').value.trim();
  const pwd = document.getElementById('l-pwd').value;
  const err = document.getElementById('l-err');
  err.textContent = '';

  // แสดง loading
  const btn = document.querySelector('#ls .btn-p');
  const origText = btn.textContent;
  btn.textContent = 'กำลังเข้าสู่ระบบ...';
  btn.disabled = true;

  try {
    const user = await SB.login(uid, pwd);
    if (!user) {
      err.textContent = 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง';
      return;
    }

    // เซ็ต global vars (ให้ตรงกับ HTML เดิม)
    CURRENT_USER = user;
    ROLE   = user.role;
    UID    = user.uid;
    UNAME  = user.name;

    // ย้าย localStorage → Supabase (ครั้งแรกเท่านั้น)
    await migrateFromLocalStorage();

    // Subscribe realtime
    SB.subscribeStock(() => {
      CACHE.clear('stock');
      CACHE.clear('stock_lots');
      CACHE.clear('stock_planning');
      // ถ้ากำลังดูหน้า stock planning ให้ refresh อัตโนมัติ
      if (document.getElementById('ps-tbl')) planStkT();
    });

    SB.subscribeReservations(payload => {
      if (payload.eventType === 'INSERT') {
        const r = payload.new;
        toast(`📦 จองสินค้าใหม่: ${r.sku} ${r.qty_requested} กก.`);
      }
    });

    // Audit
    await SB.audit('LOGIN', 'system', { role: ROLE });

    // แสดง app
    document.getElementById('ls').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    buildSB();
    nav('dash');

  } catch (e) {
    err.textContent = 'เกิดข้อผิดพลาด: ' + e.message;
    console.error('Login error:', e);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════
// audit() — แทนที่ function เดิมในไฟล์
// ════════════════════════════════════════════════
function audit(action, target, detail) {
  // เรียก async ไม่ต้อง await เพื่อไม่บล็อก UI
  SB.audit(action, target, detail).catch(console.error);
}

// ════════════════════════════════════════════════
// pgForecast() — ใช้ Supabase แทน localStorage
// ════════════════════════════════════════════════
async function pgForecast() {
  const isAll = ROLE !== 'sales';
  const ct = document.getElementById('ct');
  ct.innerHTML = '<div style="padding:40px;text-align:center;color:var(--TX3)">กำลังโหลด...</div>';

  // โหลดข้อมูล
  const slmFilter = isAll ? null : (CURRENT_USER?.slm_id || UID);
  const [fcList, products] = await Promise.all([
    SB.getForecasts(slmFilter),
    CACHE.get('products', () => SB.getProducts()),
  ]);

  // สร้าง sku map
  const skuMap = Object.fromEntries(products.map(p => [p.code, p]));
  fcList.forEach(f => {
    const p = skuMap[f.sku] || {};
    f.skuName  = p.name || f.sku;
    f.leadTime = p.lead_time || 7;
  });

  const today = new Date();

  ct.innerHTML = `
  <div class="card">
    <div class="ch"><div class="ct2">วาง Forecast จาก Excel (Ctrl+V)</div></div>
    <div class="pz" onclick="document.getElementById('fc-pi').focus()">
      <b>คลิกแล้ว Ctrl+V จาก Excel</b>
      <span style="font-size:12px">รูปแบบ: รหัสสินค้า | รหัสลูกค้า | จำนวน | วันที่ต้องการ | หมายเหตุ</span>
      <textarea id="fc-pi" style="position:absolute;opacity:0;pointer-events:none"
        onpaste="handleFcPaste(event)"></textarea>
    </div>
    <div id="fc-pv"></div>
  </div>
  <div class="card">
    <div class="ch">
      <div class="ct2">รายการ Forecast (${fcList.length} รายการ)</div>
      <div style="display:flex;gap:8px">
        ${isAll ? `<select class="btn btn-sm" id="fc-sf" onchange="pgForecast()">
          <option value="">ทุก Sales</option>
          ${SLM_IDS.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>` : ''}
        <button class="btn btn-sm btn-p" onclick="showFcModal()">+ เพิ่ม</button>
        <button class="btn btn-sm btn-g" onclick="expFC()">Export Excel</button>
      </div>
    </div>
    ${fcList.length === 0
      ? '<p style="padding:16px;color:var(--TX3)">ยังไม่มีข้อมูล</p>'
      : `<div class="tw"><table>
        <thead><tr>
          <th>Sales</th><th>รหัสสินค้า</th><th>ชื่อสินค้า</th>
          <th style="text-align:right">จำนวน</th><th>วันต้องการ</th>
          <th>วันต้องสั่ง</th><th>สถานะ</th><th>หมายเหตุ</th>
          <th>แก้ไขโดย</th>${isAll ? '<th>อนุมัติ</th>' : ''}
        </tr></thead>
        <tbody>${fcList.map(f => {
          const od = f.delivDate
            ? new Date(new Date(f.delivDate) - f.leadTime * 864e5) : null;
          const late = od && od < today;
          return `<tr style="${late ? 'background:#FEF3F2' : ''}">
            <td class="mono">${f.by}</td>
            <td class="mono">${f.sku}</td>
            <td>${(f.skuName || '').substring(0, 28)}</td>
            <td style="text-align:right;font-weight:700">${Math.round(f.qty || 0).toLocaleString()}</td>
            <td>${f.delivDate ? new Date(f.delivDate).toLocaleDateString('th-TH',{day:'2-digit',month:'short'}) : '—'}</td>
            <td style="${late ? 'color:var(--R);font-weight:700' : ''}">
              ${od ? od.toLocaleDateString('th-TH',{day:'2-digit',month:'short'}) : '—'}
            </td>
            <td>${late ? '<span class="badge bbr">สั่งด่วน</span>'
              : od && od <= new Date(Date.now()+3*864e5) ? '<span class="badge bba">ใกล้กำหนด</span>'
              : '<span class="badge bbg">ปกติ</span>'}</td>
            <td style="font-size:12px;color:var(--TX2)">${f.note || ''}</td>
            <td><span class="edby">${f.edited_by || f.by}</span></td>
            ${isAll ? `<td>${f.approved
              ? '<span class="badge bbg">✓ อนุมัติ</span>'
              : `<button class="btn btn-xs btn-g" onclick="apvFC_SB('${f.id}')">อนุมัติ</button>`
            }</td>` : ''}
          </tr>`;
        }).join('')}</tbody>
      </table></div>`
    }
  </div>`;

  // เก็บ fcList ไว้ให้ expFC ใช้
  window._fcListCache = fcList;
}

async function apvFC_SB(id) {
  await SB.approveForecast(id);
  await SB.audit('APPROVE_FC', id, {});
  toast('✓ อนุมัติ Forecast แล้ว');
  pgForecast();
}

// override cfmFCPaste ให้ใช้ Supabase
async function cfmFCPaste() {
  const arr = window._fcp || [];
  if (!arr.length) return;
  const ok = await SB.addForecasts(arr);
  if (ok) {
    await SB.audit('PASTE_FC', 'forecast', { count: arr.length });
    document.getElementById('fc-pv').innerHTML =
      `<div class="al als">✓ นำเข้าสำเร็จ ${arr.length} รายการ</div>`;
    setTimeout(pgForecast, 800);
  } else {
    document.getElementById('fc-pv').innerHTML =
      '<div class="al ald">❌ เกิดข้อผิดพลาด กรุณาลองใหม่</div>';
  }
}

// override expFC ให้ใช้ cache
function expFC() {
  const fc = window._fcListCache || [];
  toXLSX([['Forecast',
    ['Sales','รหัสสินค้า','ชื่อสินค้า','จำนวน','วันต้องการ','หมายเหตุ','อนุมัติ'],
    fc.map(f => [f.by, f.sku, f.skuName || '', f.qty, f.delivDate || '', f.note || '', f.approved ? 'Y' : 'N']),
  ]], 'Forecast_' + todayStr() + '.xlsx');
}

// ════════════════════════════════════════════════
// pgPlanStock() — อ่าน Stock จาก Supabase
// ════════════════════════════════════════════════
async function pgPlanStock() {
  document.getElementById('ct').innerHTML = `
  <div class="frow">
    <label>กลุ่มสินค้า:</label>
    <select id="gf" onchange="planStkT()">
      <option value="">ทั้งหมด</option>
      ${Object.keys(SKU_GROUPS).map(g => `<option value="${g}">${g}</option>`).join('')}
    </select>
    <input id="ss" type="text" placeholder="ค้นหา..." style="width:140px" oninput="planStkT()">
    <label>เรียงตาม:</label>
    <select id="sf" onchange="planStkT()">
      <option value="days">วันคงเหลือ</option>
      <option value="code">รหัสสินค้า</option>
    </select>
    <span style="margin-left:auto;font-size:12px;color:var(--TX3)">
      🔴 Live จาก WMS
    </span>
  </div>
  <div class="card">
    <div class="ch">
      <div class="ct2">Stock vs เฉลี่ย 3 เดือน</div>
      <button class="btn btn-sm btn-g" onclick="expPlanStk()">Export Excel</button>
    </div>
    <div id="ps-tbl"><div style="padding:30px;text-align:center;color:var(--TX3)">กำลังโหลด...</div></div>
  </div>`;

  // โหลดจาก Supabase view
  const rows = await CACHE.get('stock_planning', () => SB.getStockPlanning());
  window._planRows = rows;
  planStkT();
}

function planStkT() {
  const rows   = window._planRows || [];
  const grp    = document.getElementById('gf')?.value || '';
  const q      = (document.getElementById('ss')?.value || '').toLowerCase();
  const sortBy = document.getElementById('sf')?.value || 'days';

  let filtered = rows;
  if (grp && SKU_GROUPS[grp]) {
    const set = new Set(SKU_GROUPS[grp]);
    filtered = filtered.filter(r => set.has(r.code));
  }
  if (q) filtered = filtered.filter(r =>
    (r.code || '').toLowerCase().includes(q) ||
    (r.name || '').toLowerCase().includes(q)
  );
  if (sortBy === 'code') filtered.sort((a, b) => (a.code || '').localeCompare(b.code));

  const tbl = document.getElementById('ps-tbl');
  if (!tbl) return;

  tbl.innerHTML = `<div class="tw"><table>
  <thead><tr>
    <th>รหัสสินค้า</th><th>ชื่อสินค้า</th>
    <th style="text-align:right">Stock</th>
    <th style="text-align:right">เฉลี่ย 3 เดือน/เดือน</th>
    <th style="text-align:right">ขั้นต่ำ</th>
    <th style="text-align:right">วันคงเหลือ</th>
    <th>แนะนำ</th>
  </tr></thead>
  <tbody>${filtered.slice(0, 100).map(r => {
    const days  = r.days_remaining >= 9999 ? '∞' : r.days_remaining;
    const cls   = r.days_remaining < 14 ? 'crit-row' : r.days_remaining < 30 ? 'exp-warm' : '';
    const lc    = r.stock_qty < r.min_stock ? 'var(--R)' : r.stock_qty < r.min_stock * 2 ? 'var(--A)' : 'var(--G)';
    const rec   = r.stock_qty < r.min_stock
      ? `<span class="badge bbr">สั่งด่วน</span>`
      : r.days_remaining < 30 ? `<span class="badge bba">เฝ้าระวัง</span>`
      : `<span class="badge bbg">ปกติ</span>`;
    return `<tr class="${cls}">
      <td class="mono">${r.code}</td>
      <td>${(r.name || '').substring(0, 32)}</td>
      <td style="text-align:right;color:${lc};font-weight:700">${Math.round(r.stock_qty || 0).toLocaleString()}</td>
      <td style="text-align:right">${(r.avg3_monthly || 0).toFixed(1)}</td>
      <td style="text-align:right">${r.min_stock}</td>
      <td style="text-align:right;font-weight:700;color:${r.days_remaining < 14 ? 'var(--R)' : r.days_remaining < 30 ? 'var(--A)' : 'inherit'}">
        ${days}
      </td>
      <td>${rec}</td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
}

function expPlanStk() {
  const rows = window._planRows || [];
  toXLSX([['StockPlanning',
    ['รหัสสินค้า','ชื่อสินค้า','Stock','เฉลี่ย3เดือน','ขั้นต่ำ','วันคงเหลือ'],
    rows.map(r => [r.code, r.name, r.stock_qty, r.avg3_monthly, r.min_stock, r.days_remaining]),
  ]], 'StockPlanning_' + todayStr() + '.xlsx');
}

// ════════════════════════════════════════════════
// pgAudit() — อ่านจาก Supabase
// ════════════════════════════════════════════════
async function pgAudit() {
  document.getElementById('ct').innerHTML =
    '<div style="padding:30px;text-align:center;color:var(--TX3)">กำลังโหลด...</div>';
  const log = await SB.getAuditLog(200);
  const actionColors = {
    LOGIN:'bbl', LOGOUT:'bbgr', ADD_FC:'bbg', PASTE_FC:'bbg',
    APPROVE_FC:'bbg', ADD_PO:'bbl', EDIT_PO:'bba', MATCH_PO:'bbg',
    STOCK_IN:'bbg', ADD_USER:'bbg', EDIT_USER:'bba',
  };
  document.getElementById('ct').innerHTML = `
  <div class="ch" style="margin-bottom:14px">
    <div style="font-size:13px;color:var(--TX2)">บันทึกการใช้งาน ${log.length} รายการ</div>
    <button class="btn btn-sm btn-g" onclick="expAudit()">Export Excel</button>
  </div>
  <div class="card"><div class="tw"><table>
    <thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>Role</th><th>Action</th><th>Target</th><th>รายละเอียด</th></tr></thead>
    <tbody>${log.map(l => `<tr>
      <td style="font-size:11px;color:var(--TX3);white-space:nowrap">
        ${new Date(l.ts).toLocaleString('th-TH')}
      </td>
      <td><b class="mono">${l.uid}</b></td>
      <td><span class="badge bbgr" style="font-size:10px">${l.role}</span></td>
      <td><span class="badge ${actionColors[l.action] || 'bbgr'}">${l.action}</span></td>
      <td class="mono" style="font-size:12px">${l.target}</td>
      <td style="font-size:12px;color:var(--TX2)">${JSON.stringify(l.detail || {}).substring(0, 60)}</td>
    </tr>`).join('')}</tbody>
  </table></div></div>`;
  window._auditCache = log;
}

function expAudit() {
  const log = window._auditCache || [];
  toXLSX([['AuditLog',
    ['เวลา','UID','Role','Action','Target','Detail'],
    log.map(l => [new Date(l.ts).toLocaleString('th-TH'), l.uid, l.role, l.action, l.target, JSON.stringify(l.detail || {})]),
  ]], 'AuditLog_' + todayStr() + '.xlsx');
}

// ════════════════════════════════════════════════
// pgUsers() — อ่าน Users จาก Supabase
// ════════════════════════════════════════════════
async function pgUsers() {
  document.getElementById('ct').innerHTML =
    '<div style="padding:30px;text-align:center;color:var(--TX3)">กำลังโหลด...</div>';
  const users = await SB.getUsers();
  document.getElementById('ct').innerHTML = `
  <div class="ch" style="margin-bottom:14px">
    <div></div>
    <button class="btn btn-sm btn-p" onclick="showAddUser()">+ เพิ่มผู้ใช้</button>
  </div>
  <div class="card"><div class="tw"><table>
    <thead><tr><th>UID</th><th>ชื่อ</th><th>Role</th><th>SLM ID</th><th>อีเมล</th><th>สถานะ</th></tr></thead>
    <tbody>${users.map(u => `<tr>
      <td><b class="mono">${u.uid}</b></td>
      <td>${u.name}</td>
      <td><span class="badge ${{manager:'bba',planning:'bbl',warehouse:'bbg',sales:'bbp'}[u.role]||'bbgr'}">${u.role}</span></td>
      <td class="mono" style="font-size:12px">${u.slm_id || '—'}</td>
      <td style="font-size:12px">${u.email || '—'}</td>
      <td>${u.is_active ? '<span class="badge bbg">Active</span>' : '<span class="badge bbgr">Inactive</span>'}</td>
    </tr>`).join('')}</tbody>
  </table></div></div>`;
}

// ════════════════════════════════════════════════
// pgDash() — เพิ่ม WMS link banner
// ════════════════════════════════════════════════
// NOTE: ใส่ code นี้ใน pgDash() ต่อท้ายก่อน setTimeout(dashCharts,50)
const WMS_BANNER = `
<div class="al ali" style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between">
  <span>📦 Stock ดึงจาก WMS realtime — คลิกเพื่อดูรายละเอียด</span>
  <a href="https://tgm-wms.vercel.app" target="_blank"
     class="btn btn-sm btn-t">เปิด WMS →</a>
</div>`;
