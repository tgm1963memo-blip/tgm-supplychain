# TGM Supply Chain — Feature Spec Overview

> **สถานะล่าสุด 2026-09-17:** รายการ Punch List ด้านล่างเป็นประวัติ ณ วันที่สำรวจเดิม ไม่ใช่ backlog ปัจจุบัน ดู [รายงานปิดงานและงานภายนอกที่ยังรอ](closeout-2026-09-17.md) ซึ่งตรวจเทียบโค้ดและฐานข้อมูลใหม่แล้ว การจัดการผู้ใช้/โมดูล sync/ข้อความรับเข้า WMS ทำแล้วก่อนรอบนี้ ส่วนงานอนุมัติผู้บริหาร กลุ่มลูกค้าย้อนหลัง config API และ shared helpers อัปเดตในรอบนี้

> เอกสารนี้สร้างขึ้นจากการสำรวจโค้ดจริง (schema, migrations, API routes, sync jobs, ทุกหน้าใน `index.html`, และ comment ประวัติทั้งหมด) ของโปรเจกต์ **tgm-supplychain** ณ วันที่ 2026-08-2x เนื่องจากโปรเจกต์นี้ไม่เคยมีเอกสาร requirement ที่เป็นทางการมาก่อน (มีแค่ `server/DEPLOY.md` ซึ่งเป็น deploy runbook ไม่ใช่ feature spec) — เอกสารนี้จึงเป็น **ฉบับแรก** ที่รวบรวมภาพรวมทั้งระบบไว้ในที่เดียว โดยยึดจาก "โค้ดที่มีอยู่จริง" เป็นแหล่งความจริงหลัก ไม่ใช่จากความตั้งใจที่ยังไม่ได้ทำ
>
> อัปเดตล่าสุดควรมาจากการรัน `/programmer` + `/qa-tester` skill กับ feature ใหม่ๆ แล้วย้อนกลับมาแก้เอกสารนี้ ไม่ใช่เขียนทิ้งไว้เฉยๆ
>
> **อัปเดต 2026-09-16**: เพิ่มส่วนที่เปลี่ยนไปมากตั้งแต่ 2026-09-11 ถึง 2026-09-16 (ฟีเจอร์ใบเคาะราคา v2 ทั้งหมด, reset รหัสผ่านผ่านอีเมล, แยกแอป Sales/Planning, ปรับ Dashboard, แก้บั๊ก perf/security หลายจุด) — ดูหัวข้อ 2 (แถวใหม่), 3 (ตารางใหม่), 5 (timeline ต่อท้าย), 6 (punch list ใหม่) ส่วนเนื้อหาเดิมก่อนหน้านั้น **ยังไม่ได้ตรวจซ้ำ** (เช่น ข้อ 16 "จัดการผู้ใช้" ในตาราง module ด้านล่าง) ให้ถือว่าเป็นภาพ ณ 2026-08-2x จนกว่าจะมีคนตรวจยืนยันใหม่

---

## 1. ภาพรวมสถาปัตยกรรม

```
Express (Business Plus) ERP           tgm-supplychain (this repo)              tgm-wms (แยก repo)
  DBF files บน \\server\expsrv          Node.js + Express + SQLite               React/Vite + Supabase(Postgres) จริง
  (STMAS, ARMAS, OESO/OESOIT,           (node:sqlite, DatabaseSync)               ของตัวเอง คนละฐานข้อมูล
   STLOC, STCRD, ARTRN, ...)                    │                                        │
        │  DBF sync ทุก 5 นาที                  │                                        │
        │  (importFromExpress.js)               │                                        │
        ▼                                       ▼                                        │
   SQLite (C:\TGM-Data\supplychain-db\tgm.db) ──┼── REST API (/api/*, bearer token) ──────┘
        │                                       │       (WMSAPI service account, read-mostly)
        ▼                                       │
   index.html (single-file frontend,            │
   Supabase-client-*shaped* wrapper —            │
   ไม่ใช่ Supabase จริง ยิง fetch() ไปที่ API   │
   ของ server ตัวเองทั้งหมด)                    │
```

**ประเด็นสำคัญที่ยืนยันด้วยโค้ดจริงแล้ว (ไม่ใช่สมมติฐาน):**
- Backend ของ tgm-supplychain คือ **SQLite** (`server/db/schema.sql`, `server/db/init.js` ใช้ `node:sqlite`'s `DatabaseSync`) **ไม่ใช่ PostgreSQL**
- ข้อมูลเข้าระบบเกือบทั้งหมดผ่าน `server/jobs/importFromExpress.js` (sync จาก Express DBF ทุก 5 นาที) ไม่ใช่ผ่านฟอร์มกรอกของผู้ใช้
- `index.html` เคยคุยกับ Supabase จริงมาก่อน แต่ **ถูก migrate ออกมาคุยกับ server ของตัวเองแล้ว** (`index.html:346-351`) — ฟังก์ชันชื่อ `getSupabaseClient()` ยังใช้ชื่อเดิมเพื่อไม่ต้องแก้โค้ดหลายร้อยจุด แต่ข้างในยิง `fetch()` ไปที่ API ของ server นี้เอง (`server/lib/pgQuery.js` เป็นฝั่งที่ parse query grammar แบบ PostgREST ให้)
- **tgm-wms เป็นคนละฐานข้อมูลจริง** (Supabase/Postgres ของตัวเอง) เชื่อมกับ tgm-supplychain ผ่าน **HTTP API เท่านั้น** (ดูหัวข้อ 6)
- **(ใหม่ 2026-09-15) แอปนี้ไม่ได้ deploy เป็นชิ้นเดียวอีกต่อไป** — `index.html` ไฟล์เดียวยังเป็น source of truth ที่แก้ไขจริง แต่ตอนดีพลอยจะถูก "ตัดแยก" เป็น 2 เว็บแอปคนละ Vercel deployment: **Sales** (`vercel-deploy/`, โดเมนจริง `tss-supplychain.vercel.app`) กับ **Planning** (`planning-deploy/`, โดเมนจริง `tss-planning.vercel.app`) — เครื่องมือตัดคือ `deploy-shared/extract.js` (AST-based, ใช้ acorn parse) อ่านรายชื่อฟังก์ชัน/ตัวแปรจาก `deploy-shared/app-manifest.js`'s `SALES_ONLY`/`PLANNING_ONLY`/`WMS_ONLY` array แล้วลบทิ้งจริงจากสำเนาที่ build (ไม่ใช่แค่ซ่อนด้วย CSS/JS) พร้อม safety-net เช็คตอน build ว่าโค้ดที่เหลือ (core/shared) ไม่มีจุดไหนอ้างถึงชื่อที่ถูกตัดทิ้งไปแล้ว (ยกเว้นมี `typeof X==='function'` guard ครอบไว้ตรงๆ ในเงื่อนไข if — ดูคอมเมนต์ยาวในไฟล์นั้น) หลักการ: **default-keep, explicit-delete** — ชื่อที่ไม่ได้ระบุไว้ใน manifest เลยถือเป็น core/shared เก็บไว้ทั้ง 2 แอปเสมอ เวลาเพิ่มฟีเจอร์ใหม่ที่ควรอยู่แค่แผนกเดียว (เช่น ใบเคาะราคาเป็น sales-only ทั้งหมด) **ต้องเพิ่มชื่อฟังก์ชัน/ตัวแปรใหม่ลง manifest เอง** ไม่งั้น build script จะปล่อยผ่านเงียบๆ (เก็บไว้ทั้ง 2 แอป) จนกว่า safety-net จะจับได้ว่ามันไปเรียกฟังก์ชันที่ถูกตัดทิ้ง

---

## 2. Module/Flow Map

ตารางสรุปสถานะทุกโมดูล เรียงตามลำดับเมนูซ้ายของแอป (`RNAV`, `index.html:3879-3945`) — status มี 4 ระดับ: **✅ Full** (implement จริง + sync กับ server), **🟡 Partial** (มีบางส่วน local-only หรือมี stub), **🔴 Local-only** (ทำงานได้แต่ข้อมูลอยู่แค่ browser เดียว ไม่ sync ข้ามเครื่อง/ผู้ใช้), **⚫ Dead/Orphan** (โค้ดยังอยู่แต่ไม่มีทางเข้าถึงจาก nav ปัจจุบัน)

| # | โมดูล | Page ID | Status | หมายเหตุสั้น |
|---|---|---|---|---|
| 1 | Dashboard | `dash` | ✅ Full | KPI/chart รวม, อ่านอย่างเดียว |
| 2 | Sales Overview | `mysales` | ✅ Full* | *รายสินค้า tab เป็นค่าประมาณ (ดูรายละเอียด) |
| 3 | ฝากขาย CONSI | `consi` | ✅ Full | อ่านอย่างเดียว, drill-down ครบ |
| 4 | Sales Forecast | `forecast` | ✅ Full | CRUD ครบ + AI suggest |
| 5 | Stock & Planning | `planstock` | ✅ Full | อ่านอย่างเดียว, label ว่า "Live จาก WMS" (คำนี้ล้าสมัยบางส่วน ดูหัวข้อ 6) |
| 6 | Production Planning (PO) | `po` | ✅ Full | CRUD ครบ, match-to-SO เป็น manual prompt |
| 7 | จองสินค้า PO/SO | `planbook` | ✅ Full | CRUD ครบ |
| 8 | สรุปการจอง | `booksummary` | ✅ Full | อ่านอย่างเดียว, aggregate ของ #7 |
| 9 | สั่งยอดผลิต | `prodplan` | 🟡 Partial | CRUD ครบ แต่ **push-to-WMS เป็น stub** (ดูหัวข้อ 6) |
| 10 | เปรียบเทียบผลิต | `prodsummary` | 🟡 Partial | ฝั่ง "แผน" real, ฝั่ง "จริง" เป็น local-only import |
| 11 | ข้อมูลลูกค้า | `custreg` | 🟡 Partial | รายชื่อลูกค้า real, workflow อนุมัติเป็น **local-only** |
| 12 | ของตัวอย่าง | `sample` | 🔴 Local-only | UI ครบทั้ง flow แต่ **ไม่ sync เลย** |
| 13 | SKU Settings | `skuadmin` | ✅ Full* | *เพิ่ม SKU ใหม่/เปลี่ยนชื่อ เป็น local-only |
| 14 | จัดการกลุ่ม | `groups` | 🟡 Partial | กลุ่มลูกค้า/เซลส์ sync จริง, **กลุ่มสินค้า local-only** |
| 15 | Reports | `reports` | ✅ Full | export hub + import CSV รายงาน 73 (manual reconciliation) |
| 16 | จัดการผู้ใช้ | `users` | 🔴 **Bug จริง** | เพิ่ม user ใหม่ไม่ถึง server เลย (ดูรายละเอียด) |
| 17 | สิทธิ์การใช้งาน | `perms` | ✅ Full | sync server จริง, เพิ่งแก้จาก local-only |
| 18 | Audit Log | `auditlog` | ✅ Full | อ่านอย่างเดียว, real table |
| — (ใหม่) | ใบเคาะราคา (promo draft v2) | เข้าถึงผ่านปุ่มในหน้า `promo_history`, ไม่มี page id top-level ของตัวเอง | ✅ Full | CRUD ครบ, sales-only ทั้งโมดูล (ตัดออกจาก build ของแอป Planning) — ดูรายละเอียดข้อ 19 |
| — | WMS System | `wms` (ซ่อนใน role `warehouse`) | ✅ Full* | *ข้อความ UI อ้าง Supabase ล้าสมัย (ดูหัวข้อ 6) |
| — | (legacy) รับสินค้าเข้า | `stock` | ⚫ Orphan | เขียน localStorage ชนกับสถาปัตยกรรมจริง ถ้าถูกเปิดใช้ใหม่จะอันตราย |
| — | (legacy) Expiry | `expiry` | ⚫ Orphan | อ่านจาก localStorage stock เดียวกับข้างบน |
| — | pgCustMap | `custmap` | ⚫ Dead alias | แค่ redirect ไป Sales Overview |

รายละเอียดแต่ละโมดูล (I/O, dependency, pain point):

### 1) Dashboard
- **I/O**: อ่าน `po_plans`, `stock`, `forecasts`, `sku_settings`, `sales_history`, `v_sc_data_confidence` — ไม่มีการเขียนข้อมูล
- **Dependency**: พึ่งพา Sales Forecast (`forecasts`), Production Planning (`po_plans`), Stock & Planning (ตัวเลข stock)
- **Pain point**: กราฟ "Top 8 กลุ่มสินค้า" ใช้ **จัดการกลุ่ม (product groups)** ซึ่งเป็น local-only mapping ที่ผสมชื่อไทยที่ผู้ใช้ตั้งเองกับรหัส STKGRP ดิบ — **ไม่ตรงกับกลุ่มสินค้าจริงที่ Sales Overview ใช้ (Express STKGRP โดยตรง)** เป็นความไม่สอดคล้องที่รู้ตัวและตั้งใจแยกไว้ (ดู `index.html:5450-5458`)

### 2) Sales Overview
- **I/O**: อ่าน `sales_history`/`v_sales_history_company` (order-based) + `invoice_sales_monthly` (invoice-based, ยอดจริงจาก ARTRN.DBF) สำหรับยอดรวม/รายลูกค้า/รายเซลส์
- **Dependency**: ยอดรวมอ้างอิง invoice จริง เพราะ order-based undercount ~10 เท่า (ยืนยัน 2026-07-20)
- **Pain point ที่ระบุในโค้ดและ UI ตรงๆ**: แท็บ "รายสินค้า" **ไม่ใช่ข้อมูลจริงจาก invoice** (ARTRN ไม่มีมิติ SKU) เป็นการ **ประมาณ** โดยปรับสัดส่วนจากข้อมูล order ให้ยอดรวมเท่ากับ invoice จริง (`_sdScaleProdsToTotal`) — มีข้อความแจ้งผู้ใช้ตรงในหน้าเว็บอยู่แล้ว

### 3) ฝากขาย CONSI
- **I/O**: อ่าน `v_sc_consi_monthly` อย่างเดียว, drill-down ลูกค้า→กลุ่มสินค้า→สินค้า, export ได้
- **Dependency/Pain point**: ไม่พบ — self-contained

### 4) Sales Forecast
- **I/O**: อ่าน/เขียน `forecasts`; อ่าน `po_plans`/`bookings`/`prod_orders` เพื่อคำนวณ badge "สถานะรับของ"
- **Dependency**: เชื่อมกับ Production Planning, จองสินค้า PO/SO, สั่งยอดผลิต โดยตรง (cross-module fulfillment logic)

### 5) Stock & Planning
- **I/O**: อ่าน `v_stock_planning` (view) + `forecasts`/`po_plans`/`prod_orders` สำหรับ comparison; แท็บ "Daily" reconstruct ยอด stock ย้อนหลังจาก `stock_movements_daily`
- **Pain point**: label "🔴 Live จาก WMS" — คำนี้เป็นภาษาที่ค้างมาจากสถาปัตยกรรมเก่า จริงๆ แล้วตาราง `stock` ถูกเขียนโดย **tgm-supplychain เอง** (sync จาก Express `STLOC.DBF`) ไม่ใช่ WMS เขียนตรงเข้ามาแล้ว (ดูหัวข้อ 6)

### 6) Production Planning (PO)
- **I/O**: อ่าน/เขียน `po_plans`; import แบบ paste-Excel
- **Pain point**: `matchPO()` เป็น manual `prompt()` กรอกเลข SO เอง ไม่ได้ auto-match กับข้อมูล SO จริง — เป็นช่องว่าง process ไม่ใช่ bug

### 7) จองสินค้า PO/SO
- **I/O**: อ่าน/เขียน `bookings`
- **Dependency**: เทียบ stock กับ Stock & Planning, ส่งต่อการตัดสินใจ "สั่งผลิต vs ใช้ stock" ไปยังสั่งยอดผลิต

### 8) สรุปการจอง
- **I/O**: อ่าน aggregate ของ `bookings` (มี server view ให้ใช้ ถ้าใช้ไม่ได้ fallback client-side aggregate)
- **Dependency**: อ้างอิง Stock & Planning สำหรับคอลัมน์ "Stock ปัจจุบัน/สถานะ"

### 9) สั่งยอดผลิต
- **I/O**: อ่าน/เขียน `prod_orders`; อ้างอิง stock, forecast, PO, sales avg3
- **🔴 Stub ที่พบจริง**: ฟังก์ชัน `ppLinkToWMS()` (`index.html:3607-3627`) ทำงานเมื่อ mark order เป็น "เสร็จ" — คอมเมนต์ในโค้ดบอกตรงๆ ว่า *"This would normally call WMS API, but for now we'll store locally"* — ที่จริงแล้ว **แค่ `console.log()` + toast หลอกว่าส่งไป WMS แล้ว ไม่มีอะไรถูกส่งจริง** สต็อกจากการผลิตเสร็จ **ไม่เข้า WMS อัตโนมัติ** ผู้ใช้เห็น toast ว่าสำเร็จแต่ความจริงไม่มีอะไรเกิดขึ้น

### 10) เปรียบเทียบผลิต
- **I/O**: ฝั่งแผนอ่านจาก `prod_orders` จริง; ฝั่ง "รับเข้าจริง" อ่านจาก `prod_orders.status='done'` **หรือ** ข้อมูล import Excel ที่เก็บใน `localStorage` (`stock_in_actual`) — **ไม่ sync ข้ามเครื่อง**
- **Pain point**: ปุ่ม "ล้างข้อมูลจริง" ลบ localStorage แบบย้อนกลับไม่ได้ มีแค่ `confirm()` ธรรมดา

### 11) ข้อมูลลูกค้า
- **I/O**: รายชื่อลูกค้าหลัก sync จริงจาก `SB.getCustomers()` (Express ARMAS.DBF); workflow "ลงทะเบียน/อนุมัติ" ทั้งหมดเก็บใน `localStorage` (`custreg_subs`) รวมถึงไฟล์แนบเป็น base64
- **🔴 ช่องว่างจริง**: ขั้นตอน "ส่งอนุมัติ" หลายระดับผู้จัดการ **ไปไม่ถึงเครื่องอื่นเลย** เพราะเก็บในเบราว์เซอร์ของผู้ส่งเท่านั้น — ผู้อนุมัติที่ใช้เครื่อง/browser อื่นจะไม่เห็นคำขอเลย

### 12) ของตัวอย่าง
- **🔴 Local-only ทั้งหมด**: มี UI ครบ (สร้าง→อนุมัติ→เตรียม→จัดส่ง, KPI) แต่ grep ทั้งไฟล์ไม่พบการเรียก Supabase/API เลยสักจุด ทุกอย่างอยู่ใน `DB.get/set('sample_requests')` (localStorage) — เหมือนข้อ 11 คือ flow ข้ามผู้ใช้ใช้งานจริงไม่ได้

### 13) SKU Settings
- **I/O**: แก้ min stock/shelf life/lead time/MOQ เขียนผ่าน `SB.updateSkuSetting()` จริง มี UX สีเขียว/ส้มบอกผลการ sync ทันที (ดีมาก)
- **Pain point เล็ก**: เพิ่ม SKU custom ใหม่ หรือเปลี่ยนชื่อ SKU เขียนแค่ `localStorage` (`custom_skus`) ไม่ sync

### 14) จัดการกลุ่ม
- **I/O**: กลุ่มลูกค้า/เซลส์ sync จริง (`customer_profiles`, `salesmen_profiles`); **กลุ่มสินค้า (STKGRP mapping) เป็น local-only ทั้งหมด**
- **Dependency**: กลุ่มสินค้า local-only นี้ป้อนกราฟ Dashboard #1 — ตั้งใจแยกจาก Sales Overview ตามที่ระบุในโค้ด

### 15) Reports
- **I/O**: export hub (delegate ไปฟังก์ชัน export ของหน้าอื่น) + import CSV "รายงาน 73" ของ Express แบบ manual พร้อม cross-check สูตร (เงินสด+เครดิต+ค้าง−คืน เทียบยอดสุทธิ)
- **Pain point**: เส้นทาง reconciliation นี้เป็น manual ล้วนๆ แยกจาก sync อัตโนมัติหลัก

### 16) จัดการผู้ใช้ — 🔴 บั๊กจริงที่สำคัญที่สุดในรอบสำรวจนี้
- คอมเมนต์ในโค้ดบอกตรงๆ ว่า `// pgUsers() — จัดการผู้ใช้จาก localStorage`
- `SB.getUsers()`/`SB.upsertUser()` (เขียนตาราง `sc_users` จริงบน server) **ถูกนิยามไว้แต่ไม่มีจุดไหนในหน้า UI เรียกใช้เลย** — เป็น dead capability
- **ผลกระทบจริง**: แอดมินเพิ่มผู้ใช้ใหม่ผ่านหน้านี้ → บันทึกแค่ใน localStorage ของเครื่องแอดมินเอง **ไม่ถึง `sc_users` บน server** → ผู้ใช้ใหม่คนนั้น **login ผ่านทาง server จริงไม่ได้** (ระบบ login เช็ค server ก่อนเสมอ ไม่ fallback ไป local ถ้า server ปฏิเสธชัดเจน) — ดูเหมือนใช้งานได้แต่จริงๆ ไม่ทำงาน
- รหัสผ่านใน localStorage array นี้ยังเก็บเป็น **plaintext** ด้วย (ความเสี่ยงความปลอดภัยเพิ่ม)

### 17) สิทธิ์การใช้งาน
- **I/O**: sync กับ `/api/perms/deptpos`, `/roles`, `/feature-flags` จริง — คอมเมนต์ในโค้ดยืนยันว่านี่คือจุดที่ **แก้ปัญหาเดียวกับข้อ 16 ไปแล้ว** (เดิมก็ local-only เหมือนกัน แต่ทำ server-sync แล้วสำเร็จ) — เป็นตัวอย่างว่าการแก้ให้ถูกทำได้จริงในโปรเจกต์นี้

### 18) Audit Log
- **I/O**: อ่าน `audit_log` จริง 200 แถวล่าสุด
- **Pain point เล็ก**: การกระทำในหน้า local-only (เช่น "เพิ่มผู้ใช้" ข้อ 16) ก็ยังถูก log ว่า "ADD_USER" สำเร็จ — audit trail จึงโชว์ว่ามีการเพิ่มผู้ใช้ทั้งที่จริงไม่ถึง server เลย (inconsistency ที่ตรวจสอบยาก)

### 19) ใบเคาะราคา (promo draft v2) — โมดูลใหม่ทั้งหมด (2026-09-11 ถึง 2026-09-16)
- **I/O**: เขียน/อ่าน `promo_draft_headers` (1 แถวต่อเอกสาร — doc_no/promo_no/routing state/checkbox พิเศษ/ค่าใช้จ่ายอื่นๆ) + `promo_drafts` (1 แถวต่อ branch×SKU — ราคา/GP%/น้ำหนัก/is_sub_item) + `promo_draft_attachments` (ไฟล์แนบ, BLOB) + `promo_draft_line_comments` (comment ต่อ SKU ต่อเอกสาร) — เขียนลงระบบนี้เองทั้งหมด **ไม่เคยเขียนเข้า Express** (พนักงานคีย์เข้า Express เองหลังอนุมัติ แล้วมากดปิดสถานะเป็น `keyed_to_express` ในระบบนี้)
- **เลขที่เอกสาร**: `doc_no` (รูปแบบ `PC{พ.ศ.}-{เลขวิ่ง 4 หลัก}`) ออกแบบอะตอมมิกฝั่ง server ตอนสร้างร่าง; เมื่ออนุมัติผ่านครบทุกขั้นจริงแล้ว เอกสารเปลี่ยนชื่อเป็น "ใบโปรโมชั่น" และได้เลขใหม่แยกชุด `promo_no` (`PM{พ.ศ.}-{เลขวิ่ง 4 หลัก}`) — อ้างอิงกลับไปยัง `doc_no` เดิมเสมอ
- **Approval workflow**: multi-level ปกติ (reuse `approval_workflow_templates`, entity `promo_draft`) + ขั้นผู้บริหารแยกต่างหาก (entity `promo_draft_exec`) escalate อัตโนมัติเมื่อติ๊ก NPD/ค่าใช้จ่ายนอกสัญญา/ค่าโปรโมทการตลาด
- **⚠️ พบและแก้แล้ว (2026-09-16, /code-review)**: ถ้ายังไม่มีใครตั้งค่า route ผู้บริหาร (`promo_draft_exec` เป็น entity ใหม่ ไม่มี seed data) เดิมระบบจะปล่อยให้ผู้จัดการทั่วไปคนไหนก็ได้กด "อนุมัติ" ผ่านขั้นผู้บริหารไปเลยโดยไม่มีใครอนุมัติจริง — ตอนนี้บล็อกไว้แล้ว (`draftExecApprove()`, index.html) แต่ผลคือ **เอกสารที่ต้อง escalate จะค้างสถานะ `pending_exec_approval` ตลอดไปจนกว่าแอดมินจะตั้งค่า route ผู้บริหารจริง** ผ่านเมนู "ตั้งค่าเส้นทางอนุมัติ" — ถ้ามีรายงานว่าเอกสารค้างไม่ขยับ ให้เช็คจุดนี้ก่อน
- **ความปลอดภัยไฟล์แนบ**: จำกัดเฉพาะรูปภาพ/PDF โดยตรวจ **เนื้อไฟล์จริง (magic bytes, `server/lib/fileSignature.js`)** ไม่ใช่แค่ Content-Type ที่ client ส่งมา (ช่องโหว่ stored-XSS จริงที่เคยพบและแก้แล้ว 2026-09-15 — เดิมเช็คแค่ Content-Type ทำให้แนบไฟล์ .html ปลอมเป็นรูปได้) ใช้ pattern เดียวกับ `custreg_attachments` (คัดลอกโครงสร้างมา — ดู punch list ข้อใหม่เรื่องโค้ดซ้ำ)
- **การคำนวณราคาทุนสุทธิ**: `ราคาทุนสุทธิ = (ราคาขาย ÷ 1.07) × (1 − GP%/100)` — GP% ดึงจาก master ต่อลูกค้า (`customer_profiles.gp_pct`) เป็นค่าเริ่มต้น แก้ไขทับต่อบรรทัดได้ ฝั่ง "ราคาปกติ" auto-fill จาก `promo_docs` (ราคาขายล่าสุดที่เจอ, mirror จาก Express P1/P2 quotation docs ผ่าน `syncPromoDocs()`) เติมครั้งเดียวก่อนผู้ใช้แตะฟิลด์เท่านั้น
- **รหัสสินค้าขึ้นต้นด้วย "9"** (ราคาพิเศษที่จับสินค้าจริงหลายรายการ) แสดงเป็นรายการย่อยเลข 1.1/1.2 ใต้บรรทัดหลัก — แต่ละรายการย่อยเป็นสินค้าจริงมีราคา/ปริมาณเป็นของตัวเอง
- **ยังไม่ทำ (blocked, รอข้อมูลเพิ่ม)**: ไม่มี — ทุกข้อในแผนต้นฉบับ (`menu-fuzzy-willow.md`) เสร็จแล้ว ณ 2026-09-16
- **เทสต์**: `e2e/tests/promo-draft-creation.spec.js` (UI-level, stub SB.*) + `e2e/tests/promo-draft-api-security.spec.js` (API-level จริง: doc_no concurrency, role-gate 403, mime-type spoofing) — รวม 40+ เทสต์

### หน้า WMS System, และหน้า orphan
- **WMS System** (`wms`, เห็นเฉพาะ role `warehouse`): แสดง stock แบบอ่านอย่างเดียว + ปุ่มเปิด WMS app ในแท็บใหม่ + ข้อความ SSO — ข้อความ UI ในหน้านี้อ้างอิง Supabase ("ใช้ร่วมกันผ่าน Supabase") ซึ่ง**ล้าสมัยแล้ว** ตามหัวข้อ 6
- **(legacy) รับสินค้าเข้า / Expiry**: ไม่อยู่ใน nav ของ role ไหนเลยในปัจจุบัน แต่ router ยังเสิร์ฟได้ถ้ามีคน set page id ตรงๆ — เขียน stock ลง localStorage ซึ่ง**ขัดกับสถาปัตยกรรมจริงที่ควรมาจาก Express sync เท่านั้น** ถ้ามีใครเผลอเพิ่มกลับเข้า nav จะทำให้เกิดข้อมูล stock หลอกที่มองไม่เห็นจากที่อื่น

---

## 3. Backend Data Layer (อ้างอิงย่อ)

Schema เต็มอยู่ที่ `server/db/schema.sql` + `server/db/migrations.js` — สรุปเฉพาะกลุ่มสำคัญ:

| กลุ่ม | ตาราง/view | เจ้าของ (เขียน) | หมายเหตุ |
|---|---|---|---|
| Master data (mirror จาก Express) | `products`, `customers`, `salesmen`, `stock`, `stock_movements_daily`, `stock_movements_wms_daily`, `outbound_orders`, `outbound_lines`, `sales_transactions`, `sales_history` | `importFromExpress.js` (sync ทุก 5 นาที) | อ่านอย่างเดียวจาก API |
| App-owned overlay (กันสัมภาระ sync ทับ) | `customer_profiles`, `salesmen_profiles`, `sku_settings` | ผู้ใช้ผ่านหน้าเว็บ | ไม่ถูก sync job เขียนทับ |
| Operational (เขียนจากหน้าเว็บ) | `forecasts`, `po_plans`, `reservations`, `bookings`, `prod_orders`, `stock_lots` | ผู้ใช้ผ่านหน้าเว็บ | ไม่ sync กลับ Express |
| Invoice/รายได้จริง | `invoice_sales_monthly`, `invoices` | `importFromExpress.js` (จาก ARTRN.DBF) | invoice_sales_monthly = reconciled กับรายงานภาษีจริง; invoices = header เท่านั้น ไม่มีรายละเอียดสินค้า (ARTRN ไม่มี field SKU) |
| Rollup สำหรับหน้าเว็บ | `v_sc_dashboard_sales_monthly`, `v_sales_history_company`, `v_sales_overview_sales_monthly` | `refreshSalesRollups()` | rebuild เฉพาะเดือนปัจจุบัน+ก่อนหน้าทุกรอบ (เดือนเก่ากว่านั้น immutable, backfill ต้องทำ manual ถ้า logic เปลี่ยน) |
| Auth/สิทธิ์ | `sc_users`, `sessions`, `nav_perms_deptpos`, `nav_roles`, `feature_flags`, `password_reset_tokens` (ใหม่ 2026-09-15) | server เอง | bcrypt password, session token 12 ชม., reset token อายุ 1 ชม. ใช้ครั้งเดียว |
| Audit | `audit_log` | server เอง | เขียนตรงผ่าน `db.prepare(INSERT)` ไม่ผ่าน CRUD router ทั่วไป (กัน user ลบ log ตัวเอง) |
| ใบเคาะราคา (ใหม่ 2026-09-11 ถึง 09-16) | `promo_draft_headers`, `promo_drafts`, `promo_draft_attachments`, `promo_draft_line_comments` | ผู้ใช้ผ่านหน้าเว็บ (sales-only) | ไม่เขียนเข้า Express เลย — ดูข้อ 19 ในหัวข้อ 2 |
| อ้างอิงราคาจาก Express (mirror) | `promo_docs` | `importFromExpress.js`'s `syncPromoDocs()` | มาจาก OESO.DBF/OESOIT.DBF (เอกสาร SONUM ขึ้นต้น P1/P2, ไม่มีไฟล์ใบเสนอราคาแยกใน Express) ใช้เป็นทั้ง "ราคาโปรก่อนหน้า" และค่าตั้งต้น "ราคาปกติ" ในฟอร์มใบเคาะราคา |

**API surface**: ทุก endpoint อยู่หลัง `requireAuth` (bearer token) ผ่าน `/api/<table>` ที่ mimic query grammar แบบ PostgREST (`eq./neq./gt./in./or=/order=/limit`) รายละเอียดเต็มดูที่ `server/app.js`

---

## 4. หัวข้อพิเศษ: Shared Integration กับ tgm-wms (ไม่ใช่ Shared Database)

### สถาปัตยกรรมจริงที่ยืนยันแล้ว (ตรวจโค้ดทั้งสองฝั่ง ไม่ใช่แค่คอมเมนต์)

**tgm-supplychain กับ tgm-wms เป็นคนละฐานข้อมูลจริง**:
- tgm-supplychain → SQLite ไฟล์เดียว (`C:\TGM-Data\supplychain-db\tgm.db`)
- tgm-wms → Supabase/Postgres ของตัวเอง (คนละ instance, คนละ cloud project)

**ช่องทางเชื่อมต่อจริงมีอย่างเดียว: HTTP API** — tgm-wms เป็น client ที่อ่าน (ส่วนใหญ่) ข้อมูลจาก tgm-supplychain ผ่าน bearer-token service account ("WMSAPI"):
- endpoint ที่ทำขึ้นมาเพื่อ tgm-wms โดยเฉพาะ: `/api/wms_stock_movements_daily` (re-bucket จาก STCRD.DBF ตาม spec ที่ WMS ทีมยืนยันไว้ 2026-07-24/27), `/api/invoices` (ให้ tgm-wms ใช้ flow "จ่ายสินค้า by ใบกำกับภาษี")
- endpoint ที่ tgm-wms ใช้ร่วมกับหน้าเว็บปกติ: `/api/stock`, `/api/products`, `/api/warehouses`, `/api/outbound_orders`, `/api/outbound_lines`, `/api/customers`

**⚠️ พบคอมเมนต์/ข้อความ UI ที่ล้าสมัย ต้องแก้ไข** — `index.html` มีร่องรอยจากสถาปัตยกรรมเก่า (สมัยที่ยังต่อ Supabase จริงร่วมกับ WMS) ที่ยังไม่ได้อัปเดตหลัง migrate:
- คอมเมนต์ `// STOCK (WMS writes, SC reads)` (`index.html:1162-1163`) — **สลับทิศทางจากความจริงปัจจุบัน**: ตอนนี้ tgm-supplychain ต่างหากที่เขียน `stock` (จาก Express sync) แล้ว tgm-wms อ่านผ่าน API
- ข้อความในหน้า WMS System: *"ข้อมูล Stock ใช้ร่วมกันระหว่าง WMS และ Supply Chain ผ่าน Supabase — อัปเดต Real-time"* (`index.html` ~9756-9815) — **ไม่จริงแล้ว** เพราะไม่มี Supabase ร่วมกันอีกต่อไป
- Label "🔴 Live จาก WMS" ใน Stock & Planning (`index.html:2772`) — ก็มาจากมุมคิดเดียวกัน คลาดเคลื่อนในรายละเอียดทิศทางข้อมูล

**สถานะการ merge ที่ยังค้างอยู่** (พบใน `tgm-wms/src/lib/supabase.js`): tgm-wms เคยมีแผนรวม ownership ของ `products`/`sku_settings`/`stock`/`stock_lots` เข้าด้วยกันเป็นโมเดลเดียว ("Phase 0 of the tgm-supplychain merge") — ถูก **pause ไว้ตั้งแต่ 2026-07-24** (ฟังก์ชัน `ensureSharedProductFromSku`, `syncSharedStockSnapshot` ถูกปิดด้วย `return;` ต้นฟังก์ชัน โค้ดเดิมยังอยู่ข้างล่างแบบ unreachable) ไม่มี comment ไหนบอกว่าทำต่อแล้วจนถึงคอมเมนต์ล่าสุดที่เจอ (2026-08-14)

**⚠️ ข้อควรระวังเรื่องชื่อตารางซ้ำกัน**: ทั้งสองระบบมีตารางชื่อเดียวกัน (`products`, `stock`, `stock_lots`, `sku_settings`, `outbound_orders`) แต่เป็นคนละแถวคนละฐานข้อมูลจริงๆ — เวลาคุยเรื่อง "แก้ตาราง products" ต้องระบุให้ชัดว่าฝั่งไหน ไม่งั้นสับสนง่ายมาก

### Shared API Contract Risk Points (แทนที่ "Shared Database Risk Points" เดิม เพราะกลไกจริงคือ API ไม่ใช่ DB ร่วม)

| จุดเสี่ยง | Owner ที่ควรดูแล schema/contract | เคยเกิดปัญหาจริงมาแล้ว |
|---|---|---|
| `/api/stock` query operator (`eq.`/`in.`/`order`) | tgm-supplychain | ✅ เคยพัง — handler เดิมรองรับแค่ `eq.` ทำให้ tgm-wms's `getReservedStock()` (ใช้ `in.()`) ได้ 0 แถวเงียบๆ (แก้ 2026-08-03) |
| `/api/wms_stock_movements_daily` bucket spec | tgm-supplychain (ตาม spec ที่ WMS ทีม confirm ไว้) | ยังไม่เคยพัง แต่ต้อง sync กับทีม WMS ทุกครั้งที่แก้ STCRD prefix mapping |
| `/api/invoices` ฟิลด์ `so_num` (null vs not-null) | tgm-supplychain | ใช้แยก flow "auto-link SO" vs "manual dispatch" ฝั่ง WMS — เปลี่ยน logic ฝั่งนี้กระทบ flow จัดส่งของ WMS ตรงๆ |
| WMSAPI bearer token permission scope | tgm-supplychain (auth/RBAC) | ✅ เคยหลุด — token นี้เคยรั่ว ทำให้พบ 2026-08-05 ว่าหลาย endpoint (sales_history, forecasts, po_plans, reservations, bookings, prod_orders, audit_log) เปิดให้เขียนได้ทั้งที่ควรอ่านอย่างเดียว |
| `products`/`sku_settings`/`stock`/`stock_lots` ความเป็นเจ้าของระยะยาว | **ยังไม่ตกลงกันสุดท้าย** — อยู่ระหว่าง merge ที่ค้าง | ยังไม่พัง แต่เป็นหนี้ทางเทคนิคที่ค้างมา 1 เดือน+ ควรตัดสินใจให้จบว่าฝั่งไหนเป็นเจ้าของ |
| `stock` ที่เขียนจากหน้า legacy orphan (`pgStock`) | tgm-supplychain (ควรลบทิ้งหรือ block ทางเข้าถาวร) | ยังไม่เกิดเพราะไม่มีทางเข้า nav แต่ถ้าใครเพิ่มกลับเข้าไปจะชนกับข้อมูลจริงทันที |

---

## 5. Timeline สรุปเหตุการณ์/การตัดสินใจสำคัญ (ย่อจาก comment ในโค้ด)

- **2026-07-10/11/13** — ยืนยัน business rule พื้นฐาน: `STKTYP='0'`=สินค้าขายจริง, `DOCSTAT='M'`=order ที่นับเป็นยอดขายจริง, CONSI ต้องอ่าน STMAS/STLOC ของตัวเองเพิ่ม (สินค้า CONSI 32% ไม่มีใน TSS master)
- **2026-07-17** — พบ TSS-NV/TSSN-68 เป็นบริษัทเดียวกันคนละช่วงเวลา (ต้องกันนับซ้ำด้วย date cutover); staged rollout จำกัด sync ไว้แค่ 2 บริษัท แล้ว **ลืมขยายต่อ** (ไปเจอทีหลัง 2026-08-10)
- **2026-07-20/21** — พบยอดขายจาก order (OESO) ต่ำกว่าจริง ~10 เท่า เทียบ invoice จริง (ARTRN) → เปลี่ยนยอดหลักเป็น invoice-based
- **2026-07-24/27** — ออกแบบตาราง/endpoint เฉพาะให้ tgm-wms ใช้ (`stock_movements_wms_daily`); ฝั่ง tgm-wms พัก merge แผน "Phase 0" ไว้
- **2026-08-01 ถึง 2026-08-06** — พบบั๊กเงียบหลายจุด (query numeric-cast ผิด, `/api/stock` operator ไม่ครบ, `products.unit` ไม่เคย sync) และเพิ่มระบบ `invoices` header table ให้ WMS
- **2026-08-05 (Security review)** — แก้ช่องโหว่ชุดใหญ่พร้อมกัน (RW ที่ควรเป็น RO หลายตาราง, default password `changeme123`, audit_log เขียนได้, error log รั่ว credential, ไม่มี rate-limit login) — **การ revert แล้ว reapply วันเดียวกันไม่มีบันทึกเหตุผลไว้**
- **2026-08-10** — เจอปัญหา "ยอดขายไม่แสดง" ของ TGM/TSS-NV ค้างมา 3-8 เดือน จากบั๊ก staged-rollout ข้อ 2026-07-17
- **2026-08-11** — แก้บั๊กยอดขายรวม (สรุป TOTAL แทน NETVAL, ขาด RECTYP='4') คลาดเคลื่อน ~0.15%
- **2026-08-13** — ยืนยันเฉพาะหมวดสินค้า 001-006 เป็นสินค้าจริง
- **2026-09-11 ถึง 09-14** — เปิดตัวโมดูลใหม่ "ใบเคาะราคา" (promo draft v2, header/lines split) พร้อม approval workflow แยกขั้นผู้บริหาร, ไฟล์แนบ, comment ต่อ SKU, บังคับ "1 ใบ = 1 ช่วงเวลา"
- **2026-09-12 ถึง 09-15 (code-review หลายรอบ)** — แก้ช่องโหว่/บั๊กชุดใหญ่: session-throttle, role-gate บน comment POST, mime-type allowlist บนไฟล์แนบ, transaction wrap บน migration, `crud.js`/`pgQuery.js` fix, ปุ่ม "บันทึกร่าง" กดซ้ำสร้างเอกสารซ้ำ (พบเอกสารซ้ำจริงในระบบ production PC2569-0003 ถึง -0008 — ตรวจสอบภายหลัง 2026-09-16 พบว่าหายไปเองแล้ว/ฐานข้อมูลถูกกู้คืนจาก backup ระหว่างทาง)
- **2026-09-15** — Phase 4: แยก deploy เป็น 2 แอป (Sales/Planning) ด้วย `deploy-shared/extract.js` + `app-manifest.js`; เพิ่มระบบ reset รหัสผ่านผ่านอีเมล (`password_reset_tokens`, `server/lib/mailer.js`, nodemailer); ปรับ Dashboard (เอาการ์ดเล็กออก, เพิ่ม Top 10 สินค้า/ลูกค้า + ตัวกรองพนักงานขาย); พบและแก้ช่องโหว่ mime-type spoofing (stored XSS) จริงในระบบไฟล์แนบทั้ง `promo_draft_attachments`/`custreg_attachments`
- **2026-09-16** — แก้บั๊ก perf จริงที่ผู้ใช้รายงาน ("จัดการกลุ่ม โหลดไม่ขึ้น") — ต้นเหตุคือ dropdown เต็มรูปแบบ (ทั้ง sales list, product list) ถูก render ซ้ำในทุกแถวของตารางที่มีลูกค้า/สินค้าเป็นพันแถว (พบเพิ่มอีก 2 จุดที่มีบั๊กเดียวกัน: จัดการกลุ่ม > กลุ่มสินค้า, ฟอร์มของตัวอย่าง) แก้เป็น shared `<datalist>` ทั้งหมด; ทำ /code-review รอบเต็ม (7 มุมมอง) เจอบั๊กจริง 7 ข้อรวมถึง**การอนุมัติผู้บริหารถูก bypass ได้เงียบๆ เมื่อยังไม่ตั้งค่า route** — แก้ครบแล้ว (ดูหัวข้อ 6 ข้อใหม่)

---

## 6. จุดขัดแย้ง / เอกสารล้าสมัย / งานค้าง (Punch List)

1. **`server/DEPLOY.md` ล้าสมัย 2 จุด**: (ก) ยังบอก default login `SADM`/`changeme123` ทั้งที่แก้เป็น random password ไปแล้ว 2026-08-05 (ข) บอกว่า sync job "ยังเป็น skeleton" ทั้งที่ตอนนี้สมบูรณ์มาก
2. **คอมเมนต์/ข้อความ UI เรื่อง "share ผ่าน Supabase" ล้าสมัย** — ดูหัวข้อ 4
3. **`index.html` comment ที่ `app.js:236-238`** อ้างว่า fallback try/catch เก่าใน `SB.getSalesHistory()` ฯลฯ "ไม่ควร trigger แล้ว" — โค้ด fallback ยังอยู่จริง ไม่มีอะไรยืนยันว่าตายจริงหรือยังไง
4. **`importFromExpress.js` header ยังเขียนว่า "OPEN QUESTIONS"** ทั้งที่ทั้ง 6 ข้อถูก RESOLVED หมดแล้ว — header ไม่ได้อัปเดตตาม
5. **ไฟล์ซ้ำที่ไม่ได้ใช้แล้ว**: `index_utf8.html`, `index.html.bak` (เก่ากว่า `index.html` ปัจจุบันมาก ไม่มี route ไหนอ้างถึง) ควรพิจารณาลบทิ้ง
6. **ngrok tunnel เป็น "stopgap ชั่วคราว" มาตั้งแต่ 2026-08-04** รอ DNS ของ `tgm.co.th` ชี้ไป Cloudflare จริง — ยังไม่มีสัญญาณว่าทำเสร็จ ทำให้ auth gate ชั่วคราว (`TUNNEL_ACCESS_PASSWORD`) ก็ยังค้างอยู่ด้วย
7. **หน้า "จัดการผู้ใช้" (ข้อ 16 ในหัวข้อ 2) เป็นบั๊กที่ควรแก้ก่อนเรื่องอื่น** — เพิ่มผู้ใช้ใหม่ไม่ทำงานจริง (แค่ localStorage) ทั้งที่ backend มีฟังก์ชันรองรับพร้อมแล้ว (`SB.upsertUser`) แค่ไม่มีใครเรียกใช้
8. **โมดูล local-only 3 ตัว (ของตัวอย่าง, workflow อนุมัติลูกค้าใหม่, ข้อมูล "รับเข้าจริง" ของเปรียบเทียบผลิต)** ใช้งานได้แค่คนเดียว/เครื่องเดียว ทั้งที่ออกแบบ UI มาเป็น multi-step workflow ข้ามคน — ต้อง sync ขึ้น server จริงถ้าจะใช้งานตามที่ตั้งใจ
9. **`ppLinkToWMS()` เป็น stub ที่หลอกผู้ใช้ว่าสำเร็จ** — ควรแก้เป็นเรียก API จริง หรืออย่างน้อยเปลี่ยนข้อความ toast ไม่ให้เข้าใจผิดว่าส่งไป WMS แล้ว
10. **ownership ของ `products`/`sku_settings`/`stock`/`stock_lots` ระหว่าง tgm-supplychain กับ tgm-wms ยังไม่ปิดจ็อบ** ("Phase 0" ค้างตั้งแต่ 2026-07-24)
11. **(ใหม่ 2026-09-16) ระบบไฟล์แนบซ้ำกัน 2 ชุด** — `promo_draft_attachments` (routes/schema/client method) เป็นสำเนาแทบทุกบรรทัดของ `custreg_attachments` ที่มีอยู่ก่อน (คอมเมนต์ในโค้ดเองก็บอกว่า "คัดลอกโครงจาก custreg_attachments") — แก้บั๊กหนึ่งจุด (เช่น mime-type check) ต้องแก้ 2 ที่ให้ตรงกันเองด้วยมือ ทางแก้ระยะยาวคือรวมเป็นตาราง `attachments` กลางคีย์ด้วย `(entity_type, entity_id)` — **ยังไม่ทำ** เพราะความเสี่ยง refactor ระบบที่ใช้งานจริงอยู่ (custreg) สูงกว่าประโยชน์ตอนนี้
12. **(ใหม่ 2026-09-16) ระบบ approval-workflow ถูกทำซ้ำ 3 ชุด** — `draftApprove()`/`draftExecApprove()` (ใบเคาะราคา เส้นทางปกติ/ผู้บริหาร) กับ `crDoApprove()` (custreg) เป็น logic เดินขั้นอนุมัติแบบเดียวกันเกือบทุกบรรทัด (any/all mode, reject, level-advance) — บั๊กจริงที่พบและแก้แล้ว (ผู้บริหาร bypass ได้เมื่อ route ว่าง) เป็นตัวอย่างว่าการแก้ logic แบบนี้ต้องตรวจให้ครบทั้ง 3 จุดด้วยมือ ทางแก้ระยะยาวคือดึงเป็น shared helper `advanceApprovalWorkflow()` — **ยังไม่ทำ**
13. **(ใหม่ 2026-09-16) เอกสารที่ escalate ไปขั้นผู้บริหารจะค้างสถานะตลอดไปถ้าไม่มีใครตั้งค่า route ผู้บริหาร** — เป็นผลข้างเคียงที่ตั้งใจจากการแก้บั๊ก bypass (ข้อ 12) ไม่ใช่บั๊กใหม่ แต่ยังไม่มี UI แจ้งเตือนแอดมินให้ไปตั้งค่า `promo_draft_exec` workflow template เชิงรุก (ต้องรู้เองว่ามันค้างเพราะเหตุนี้)

---

## 7. คำถามเปิด/ข้อเสนอแนะขั้นต่อไป

- อยากให้แก้บั๊ก "จัดการผู้ใช้" (ข้อ 7 ใน punch list) เป็นลำดับแรกไหม เพราะกระทบการใช้งานจริงเงียบๆ มานาน
- อยากให้ตัดสินใจ ownership ของ 4 ตาราง shared-concept กับ tgm-wms ให้จบ (ข้อ 10) ก่อนจะพัฒนาฟีเจอร์ใหม่ที่แตะตารางเหล่านี้ต่อไปไหม
- โมดูล local-only ทั้ง 3 ตัว จะ sync ขึ้น server เป็นลำดับถัดไปไหม หรือยังไม่ใช่ priority ตอนนี้
- เอกสารนี้ควรใช้เป็น baseline ให้ `/programmer` skill อ้างอิงตอนรับ feature_spec ใหม่ทุกครั้ง — แนะนำอัปเดตไฟล์นี้ทุกครั้งที่มี feature ใหญ่เข้าไปเปลี่ยนภาพรวม
- **(ใหม่ 2026-09-16)** ต้องตั้งค่า "เส้นทางอนุมัติผู้บริหาร" (`promo_draft_exec` workflow template) ก่อนมีเอกสารใบเคาะราคาใบแรกที่ติ๊ก NPD/ค่าใช้จ่ายนอกสัญญา/ค่าโปรโมท ไม่งั้นเอกสารนั้นจะค้างสถานะ "รอผู้บริหารอนุมัติ" ตลอดไป (ข้อ 13 ใน punch list) — อยากให้ตั้งค่าเลยไหม หรือรอให้เจอเอกสารจริงก่อน
- **(ใหม่ 2026-09-16)** อยากให้ทำ refactor รวมระบบไฟล์แนบ (ข้อ 11) และ/หรือระบบ approval-workflow (ข้อ 12) ให้เป็นโค้ดกลางชุดเดียวไหม — ประเมินไว้ว่าเป็นงานใหญ่ใช้เวลา และมีความเสี่ยงต่อฟีเจอร์ custreg ที่ใช้งานจริงอยู่แล้ว จึงยังไม่ได้ลงมือทำเองจนกว่าจะถามก่อน
