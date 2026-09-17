// ตรวจไฟล์แนบจากเนื้อไฟล์จริง (magic bytes) ไม่ใช่แค่ Content-Type ที่ client อ้างมาในฟอร์ม multipart
// (2026-09-15, พบจาก qa-tester review — ยืนยันด้วยการทดสอบจริง: อัปโหลดไฟล์ .html พร้อม script tag แล้ว
// ปลอม Content-Type เป็น image/png ผ่าน fileFilter เดิมได้จริง เพราะ multer's fileFilter เช็คแค่ค่าที่
// client ประกาศเอง (`file.mimetype`) — ตั้งอะไรก็ได้ ไม่ได้แปลว่าไบต์จริงตรงกับที่อ้าง) ใช้ร่วมกันทั้ง
// promoDraftAttachments.js และ custregAttachments.js (ช่องโหว่เดียวกันเป๊ะทั้งสองไฟล์ เพราะ copy กันมา)

const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a / GIF89a
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

function matchesSignature(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

// WEBP is RIFF....WEBP — the 4-byte size field between the two fixed markers varies per file.
function isWebp(buf) {
  return buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP';
}

// คืนค่า true ถ้าเนื้อไฟล์จริง (magic bytes) ตรงกับ mimetype ที่ client ประกาศไว้ อย่างน้อยหนึ่งประเภทที่
// รู้จัก (image/jpeg, image/png, image/gif, image/webp, application/pdf) — ไม่ใช่แค่เช็คว่ามี signature
// ของ "ไฟล์ที่รองรับ" ประเภทใดประเภทหนึ่งลอยๆ (นั่นจะยังปลอมข้ามประเภทได้ เช่นอ้าง image/png แต่ส่ง PDF จริง)
function contentMatchesDeclaredType(buffer, declaredMime) {
  if (declaredMime === 'image/webp') return isWebp(buffer);
  const sig = SIGNATURES.find((s) => s.mime === declaredMime);
  if (!sig) return false;
  return matchesSignature(buffer, sig.bytes);
}

module.exports = { contentMatchesDeclaredType };
