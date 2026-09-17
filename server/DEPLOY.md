# ติดตั้งบน DB PC (เครื่องที่วงเน็ตเดียวกับ Express)

## 1. ติดตั้ง Node.js
ต้องใช้ **Node.js 22.5 ขึ้นไป** (แนะนำ Node 22 LTS) เพราะใช้ `node:sqlite` ที่มากับตัว Node เอง — **ไม่ต้องติดตั้ง
Visual Studio Build Tools หรือคอมไพเลอร์ใดๆ เพิ่ม** (ตั้งใจเลือกแบบนี้เพื่อไม่ให้ติดปัญหา native build บนคอมออฟฟิศทั่วไป)

ดาวน์โหลดจาก https://nodejs.org (เลือก LTS) แล้วติดตั้งตามปกติ ตรวจสอบด้วย:
```
node --version
```

## 2. คัดลอก source ไปไว้บน DB PC
ต้องมี `server/`, `shared/` และ `index.html` ในโฟลเดอร์แม่เดียวกัน เช่น `C:\tgm-supplychain\` และรันจาก `server/`

## 3. ตั้งค่า `.env`
คัดลอก `.env.example` เป็น `.env` แล้วแก้:
```
PORT=3000
CORS_ORIGINS=http://<subnet ของผู้ใช้>...   <- ใส่ origin ของเครื่อง client จริง (ดู index.html รันจาก port ไหน)
EXPRESS_DBF_ROOT=\\server\ExpressI
```

## 4. ติดตั้ง dependencies
```
cd C:\tgm-server
npm install
```

## 5. ทดสอบรันแบบธรรมดาก่อน
```
node server.js
```
เปิด browser ไปที่ `http://localhost:3000/api/health` ต้องเห็น `{"ok":true,...}`
ล็อกอินครั้งแรกด้วย `SADM` และรหัสผ่านสุ่มที่ระบบแสดงใน console ตอนสร้างฐานข้อมูลใหม่ครั้งแรกเท่านั้น
**เปลี่ยนรหัสผ่านทันทีผ่านหน้า "จัดการผู้ใช้" หลัง login**

## 6. เปิด Windows Firewall ให้ port ที่ตั้งไว้ (ค่าเริ่มต้น 3000)
```
netsh advfirewall firewall add rule name="TGM API" dir=in action=allow protocol=TCP localport=3000
```
เครื่องผู้ใช้ (คนละวงเน็ต) ต้องข้าม VLAN มาถึง port นี้ได้ — ส่วนนี้เป็นงาน routing/firewall ระดับเครือข่ายที่ทีม IT
ต้องเปิดทางให้ นอกเหนือจากการตั้งค่าไฟล์นี้

## 7. รันเป็น Windows Service (ให้ทำงาน 24 ชม. อัตโนมัติแม้เครื่อง reboot)
เครื่อง production ปัจจุบันใช้ NSSM service ชื่อ `TGMSupplyChainServer` (ดู `install-services.ps1`) และตั้ง `DB_PATH=C:\TGM-Data\supplychain-db\tgm.db` นอก OneDrive อย่ารันตัวติดตั้ง service ซ้ำเพื่ออัปเดตโค้ด เพราะจะลบการตั้งค่าเดิม ให้ restart เฉพาะ service backend หลังตรวจและสำรองฐานข้อมูลแล้ว

ตัวอย่างทางเลือกสำหรับเครื่องใหม่ที่เลือกใช้ PM2 แทน NSSM (อย่ารันสองแบบพร้อมกัน):
```
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\tgm-server
pm2 start server.js --name tgm-server
pm2 save
```
ถ้าเครื่อง reboot หรือ process ค้าง pm2 จะ restart ให้อัตโนมัติ ตรวจสอบสถานะด้วย `pm2 status` /
ดู log ด้วย `pm2 logs tgm-server`

## 8. ยืนยันว่า sync ทุก 5 นาทีทำงาน
ดูตาราง `sync_log` ในฐานข้อมูลที่ `DB_PATH` ชี้ไป ควรมีแถวใหม่ทุก 5 นาที งานจริงอยู่ใน `jobs/importFromExpress.js` และทำงานบน worker แยกจาก HTTP server ตรวจทั้งสถานะ sync และวันที่ข้อมูลล่าสุด

## Backup
ใช้ `node server/tools/backup-db.js <DB_PATH> <backup-directory>` จากโฟลเดอร์แม่ เครื่องมือนี้ใช้ SQLite online backup ที่รวมข้อมูล WAL และตรวจ `quick_check` ห้าม copy เฉพาะไฟล์ `.db` ขณะ service ทำงาน

รายละเอียด workflow ผู้บริหาร, การอัปเดตกลุ่มลูกค้าย้อนหลัง, API URL, การ deploy และ rollback: [closeout-2026-09-17.md](../docs/closeout-2026-09-17.md)
