-- ============================================================
-- TGM INTEGRATED SYSTEM — SUPABASE SCHEMA
-- Step 1: วาง SQL นี้ใน Supabase SQL Editor แล้วกด Run
-- ============================================================
-- ลำดับการรัน: รันทีละ SECTION ตามลำดับ 1→2→3→4→5
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS & HELPERS
-- ============================================================

create extension if not exists "uuid-ossp";

-- helper function: updated_at auto-update
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ============================================================
-- SECTION 2: MASTER DATA TABLES
-- ============================================================

-- 2A. สินค้า (Products / SKU Master)
-- ข้อมูลหลักที่ทุกระบบใช้ร่วม: WMS, Supply Chain, Reservation
create table if not exists products (
  code          text primary key,               -- รหัสสินค้า เช่น 10003, 10154
  name          text not null,                  -- ชื่อสินค้า
  group_name    text,                           -- กลุ่ม: ไส้กรอก, แฮม, เบค่อน, สเต็ก, อื่นๆ
  lead_time     int  not null default 7,        -- Lead time (วัน) ก่อนวันที่ลูกค้าต้องการ
  moq           int  not null default 0,        -- Minimum Order Quantity
  min_stock     int  not null default 50,       -- Stock ขั้นต่ำ (trigger alert)
  shelf_life    int  not null default 30,       -- อายุสินค้า (วัน)
  plant         text not null default 'TGM1',   -- TGM1 หรือ TGM2 (โรงงาน)
  is_active     boolean not null default true,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- index สำหรับ filter ตามกลุ่ม
create index if not exists idx_products_group on products(group_name);
create index if not exists idx_products_active on products(is_active);


-- 2B. ลูกค้า (Customers)
create table if not exists customers (
  code          text primary key,               -- รหัสลูกค้า เช่น 30-LA-0050
  name          text not null,                  -- ชื่อบริษัท
  cust_group    text,                           -- กลุ่มลูกค้า: BB, HH, KK, ...
  slm_id        text,                           -- รหัส Sales ที่ดูแล
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_customers_updated_at
  before update on customers
  for each row execute function set_updated_at();

create index if not exists idx_customers_slm    on customers(slm_id);
create index if not exists idx_customers_group  on customers(cust_group);


-- 2C. ประวัติยอดขายรายเดือน (Sales History)
-- เก็บข้อมูลย้อนหลัง ไม่เปลี่ยนแปลงบ่อย (อัปเดตรายเดือน)
create table if not exists sales_history (
  id            bigserial primary key,
  slm_id        text not null,                  -- รหัส Sales (103, 104, ...) หรือ 'ALL'
  sku           text not null references products(code),
  ym            text not null,                  -- ปี-เดือน เช่น '2026-01'
  qty           numeric not null default 0,     -- ยอดขาย (กก.)
  amount        numeric not null default 0,     -- มูลค่าขาย (บาท)
  created_at    timestamptz not null default now(),
  unique(slm_id, sku, ym)
);

create index if not exists idx_sales_hist_slm  on sales_history(slm_id);
create index if not exists idx_sales_hist_sku  on sales_history(sku);
create index if not exists idx_sales_hist_ym   on sales_history(ym);


-- ============================================================
-- SECTION 3: USER MANAGEMENT
-- ============================================================

-- 3A. Users ระบบ Supply Chain (แยกจาก Supabase Auth)
-- ใช้ระบบ login ของ app เอง (uid + password hash)
create table if not exists sc_users (
  uid           text primary key,               -- รหัสพนักงาน เช่น 208, PLN01, MGR01
  name          text not null,
  role          text not null                   -- sales | planning | warehouse | manager
                  check (role in ('sales','planning','warehouse','manager')),
  slm_id        text,                           -- สำหรับ Sales: รหัส SLM ที่ map กับ sales_history
  email         text,
  pwd_hash      text not null default '1234',   -- TODO: เปลี่ยนเป็น bcrypt ก่อน production
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    text,
  updated_at    timestamptz not null default now()
);

create trigger trg_sc_users_updated_at
  before update on sc_users
  for each row execute function set_updated_at();

-- seed ข้อมูล users เริ่มต้น
insert into sc_users (uid, name, role, slm_id, email, created_by) values
  ('MGR01', 'ผู้จัดการ',         'manager',   null,  'mgr@tgm.co.th',  'SYSTEM'),
  ('PLN01', 'ฝ่ายวางแผน',        'planning',  null,  'plan@tgm.co.th', 'SYSTEM'),
  ('WH01',  'ฝ่ายคลังสินค้า',    'warehouse', null,  'wh@tgm.co.th',   'SYSTEM'),
  ('208',   'Sales ทีมห้าง 1',   'sales',     '208', 's208@tgm.co.th', 'SYSTEM'),
  ('152',   'Sales ทีมห้าง 2',   'sales',     '152', 's152@tgm.co.th', 'SYSTEM'),
  ('101',   'Sales ทีมร้านค้า',  'sales',     '101', 's101@tgm.co.th', 'SYSTEM')
on conflict (uid) do nothing;


-- ============================================================
-- SECTION 4: OPERATION TABLES (เขียน-อ่านบ่อย)
-- ============================================================

-- 4A. Sales Forecast
create table if not exists forecasts (
  id            text primary key default 'FC' || to_char(now(),'YYYYMMDD') || substr(gen_random_uuid()::text,1,6),
  created_by    text not null,                  -- uid ของ Sales
  slm_id        text,                           -- slm_id ของ Sales (copy มาตอน insert)
  sku           text not null references products(code),
  cust_code     text references customers(code),
  qty           numeric not null check (qty > 0),
  deliv_date    date,                           -- วันที่ลูกค้าต้องการ
  note          text,
  is_approved   boolean not null default false,
  approved_by   text,
  approved_at   timestamptz,
  edited_by     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_forecasts_updated_at
  before update on forecasts
  for each row execute function set_updated_at();

create index if not exists idx_forecasts_slm      on forecasts(slm_id);
create index if not exists idx_forecasts_sku      on forecasts(sku);
create index if not exists idx_forecasts_date     on forecasts(deliv_date);
create index if not exists idx_forecasts_approved on forecasts(is_approved);


-- 4B. PO Plan (Production Order Plan)
create table if not exists po_plans (
  id            text primary key,               -- เช่น PO-001
  sku           text not null references products(code),
  qty           numeric not null check (qty > 0),
  deliv_date    date,
  customer      text,                           -- ชื่อลูกค้า (free text)
  cust_code     text,                           -- รหัสลูกค้า (optional)
  branch        text,                           -- สาขา / โรงงาน
  status        text not null default 'pending'
                  check (status in ('pending','matched','overdue','cancelled')),
  so_ref        text,                           -- SO reference จากระบบ Express
  note          text,
  version       int not null default 1,
  created_by    text not null,
  edited_by     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_po_plans_updated_at
  before update on po_plans
  for each row execute function set_updated_at();

create index if not exists idx_po_plans_sku    on po_plans(sku);
create index if not exists idx_po_plans_status on po_plans(status);
create index if not exists idx_po_plans_date   on po_plans(deliv_date);


-- 4C. Stock (owned by WMS — Supply Chain อ่านอย่างเดียว)
-- NOTE: ถ้า WMS มี table ชื่อนี้อยู่แล้ว → ข้ามขั้นนี้
-- ถ้ายังไม่มี → สร้างไว้รอ WMS มาเชื่อม
create table if not exists stock (
  sku           text primary key references products(code),
  qty           numeric not null default 0,
  unit          text not null default 'กก.',
  last_updated  timestamptz not null default now()
);

-- 4D. Stock Lots (WMS เขียน)
create table if not exists stock_lots (
  id            bigserial primary key,
  sku           text not null references products(code),
  lot_no        text not null,
  qty           numeric not null default 0,
  exp_date      date,
  in_date       date not null default current_date,
  note          text,
  created_at    timestamptz not null default now(),
  unique(sku, lot_no)
);

create index if not exists idx_stock_lots_sku     on stock_lots(sku);
create index if not exists idx_stock_lots_exp     on stock_lots(exp_date);


-- 4E. Reservations (จองสินค้า — เขียนจาก Supply Chain, อ่านจาก WMS)
create table if not exists reservations (
  id            text primary key default 'RES' || substr(gen_random_uuid()::text,1,8),
  sku           text not null references products(code),
  qty_requested numeric not null check (qty_requested > 0),
  qty_approved  numeric,                        -- Warehouse ยืนยันจำนวน
  cust_code     text,
  cust_name     text,
  need_date     date,
  status        text not null default 'pending'
                  check (status in ('pending','approved','partial','fulfilled','cancelled')),
  requested_by  text not null,                  -- uid Sales/Planning
  approved_by   text,                           -- uid Warehouse
  approved_at   timestamptz,
  note          text,
  ref_forecast_id text,                         -- link กับ forecasts.id
  ref_po_id       text,                         -- link กับ po_plans.id
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_reservations_updated_at
  before update on reservations
  for each row execute function set_updated_at();

create index if not exists idx_reservations_sku    on reservations(sku);
create index if not exists idx_reservations_status on reservations(status);
create index if not exists idx_reservations_by     on reservations(requested_by);


-- 4F. SKU Settings (Planning ตั้งค่า)
create table if not exists sku_settings (
  sku           text primary key references products(code),
  min_stock     int not null default 50,
  shelf_life    int not null default 30,
  moq           int not null default 0,
  lead_time     int not null default 7,
  note          text,
  updated_by    text,
  updated_at    timestamptz not null default now()
);


-- ============================================================
-- SECTION 5: AUDIT & LOGGING
-- ============================================================

-- 5A. Audit Log
create table if not exists audit_log (
  id            bigserial primary key,
  ts            timestamptz not null default now(),
  uid           text not null,
  role          text,
  action        text not null,                  -- LOGIN, ADD_FC, APPROVE_FC, STOCK_IN, ...
  target        text,                           -- id/code ที่ถูก action
  detail        jsonb,
  ip_addr       text                            -- optional
);

create index if not exists idx_audit_uid    on audit_log(uid);
create index if not exists idx_audit_action on audit_log(action);
create index if not exists idx_audit_ts     on audit_log(ts desc);

-- Auto-delete logs เกิน 90 วัน (optional — uncomment ถ้าต้องการ)
-- create index if not exists idx_audit_ts_del on audit_log(ts);


-- ============================================================
-- SECTION 6: ROW LEVEL SECURITY (RLS)
-- ============================================================
-- NOTE: เปิด RLS เมื่อพร้อม production
-- ตอนนี้ให้ anon key อ่านได้ก่อน เพราะระบบใช้ service_role จาก frontend
-- (ระบบ auth ทำเองไม่ใช่ Supabase Auth)

-- เปิด RLS ทุก table
alter table products      enable row level security;
alter table customers     enable row level security;
alter table sales_history enable row level security;
alter table sc_users      enable row level security;
alter table forecasts     enable row level security;
alter table po_plans      enable row level security;
alter table stock         enable row level security;
alter table stock_lots    enable row level security;
alter table reservations  enable row level security;
alter table sku_settings  enable row level security;
alter table audit_log     enable row level security;

-- Policy: anon key อ่านได้ทุก table (ใช้ระหว่าง development)
-- เปลี่ยนเป็น specific roles ก่อน production

create policy "anon_read_products"      on products      for select using (true);
create policy "anon_read_customers"     on customers     for select using (true);
create policy "anon_read_sales_history" on sales_history for select using (true);
create policy "anon_read_stock"         on stock         for select using (true);
create policy "anon_read_stock_lots"    on stock_lots    for select using (true);
create policy "anon_read_sku_settings"  on sku_settings  for select using (true);

-- sc_users: อ่านได้ แต่ไม่แสดง pwd_hash (ทำใน view)
create policy "anon_read_sc_users"      on sc_users      for select using (true);

-- forecasts: อ่าน-เขียนได้ (auth ทำที่ app layer)
create policy "anon_all_forecasts"      on forecasts     for all  using (true) with check (true);
create policy "anon_all_po_plans"       on po_plans      for all  using (true) with check (true);
create policy "anon_all_reservations"   on reservations  for all  using (true) with check (true);
create policy "anon_all_sku_settings"   on sku_settings  for all  using (true) with check (true);
create policy "anon_all_audit_log"      on audit_log     for all  using (true) with check (true);


-- ============================================================
-- SECTION 7: VIEWS (ช่วยให้ query ง่ายขึ้น)
-- ============================================================

-- 7A. Stock + Planning view — ใช้ใน pgPlanStock()
create or replace view v_stock_planning as
select
  p.code,
  p.name,
  p.group_name,
  p.lead_time,
  coalesce(s.qty, 0)              as stock_qty,
  coalesce(ss.min_stock, p.min_stock) as min_stock,
  coalesce(ss.lead_time, p.lead_time) as effective_lt,
  -- เฉลี่ย 3 เดือนล่าสุด (จาก sales_history ทั้งหมด)
  coalesce(
    (select round(avg(sh.qty)::numeric, 1)
     from sales_history sh
     where sh.sku = p.code
       and sh.slm_id = 'ALL'
       and sh.ym >= to_char(now() - interval '3 months', 'YYYY-MM')
    ), 0
  )                               as avg3_monthly,
  -- วันคงเหลือ (ถ้า avg > 0)
  case
    when coalesce(
      (select avg(sh.qty) from sales_history sh
       where sh.sku = p.code and sh.slm_id = 'ALL'
       and sh.ym >= to_char(now() - interval '3 months', 'YYYY-MM')
      ), 0) > 0
    then round(
      coalesce(s.qty,0) /
      (coalesce(
        (select avg(sh.qty) from sales_history sh
         where sh.sku = p.code and sh.slm_id = 'ALL'
         and sh.ym >= to_char(now() - interval '3 months', 'YYYY-MM')
        ), 1) / 30)
    )
    else 9999
  end                             as days_remaining
from products p
left join stock s         on s.sku = p.code
left join sku_settings ss on ss.sku = p.code
where p.is_active = true;


-- 7B. sc_users ไม่แสดง pwd_hash
create or replace view v_sc_users_safe as
select uid, name, role, slm_id, email, is_active, created_at
from sc_users;


-- 7C. Forecast summary per SKU per month
create or replace view v_forecast_summary as
select
  f.sku,
  p.name                          as sku_name,
  to_char(f.deliv_date, 'YYYY-MM') as ym,
  f.slm_id,
  count(*)                        as entry_count,
  sum(f.qty)                      as total_qty,
  sum(case when f.is_approved then f.qty else 0 end) as approved_qty
from forecasts f
join products p on p.code = f.sku
where f.deliv_date is not null
group by f.sku, p.name, to_char(f.deliv_date, 'YYYY-MM'), f.slm_id;


-- 7D. Reservations + stock check
create or replace view v_reservation_status as
select
  r.*,
  p.name                          as sku_name,
  coalesce(s.qty, 0)              as stock_available,
  case
    when coalesce(s.qty,0) >= r.qty_requested then 'sufficient'
    when coalesce(s.qty,0) > 0               then 'partial'
    else                                           'out_of_stock'
  end                             as stock_status
from reservations r
join products p on p.code = r.sku
left join stock s on s.sku = r.sku;


-- ============================================================
-- SECTION 8: REALTIME SUBSCRIPTIONS
-- ============================================================
-- เปิด Realtime ให้ tables ที่ต้องการ live update

alter publication supabase_realtime add table stock;
alter publication supabase_realtime add table stock_lots;
alter publication supabase_realtime add table reservations;
alter publication supabase_realtime add table forecasts;
alter publication supabase_realtime add table po_plans;


-- ============================================================
-- DONE ✓
-- ============================================================
-- Tables สร้างแล้ว:
--   products, customers, sales_history
--   sc_users, forecasts, po_plans
--   stock, stock_lots, reservations
--   sku_settings, audit_log
-- Views:
--   v_stock_planning, v_sc_users_safe
--   v_forecast_summary, v_reservation_status
-- ============================================================
