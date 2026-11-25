'use strict';

// แปลง "ข้อมูลลูกค้า/มาสเตอร์ไฟล์.xlsx" (ชีตแรก: รหัสลูกค้า | ชื่อลูกค้า | กลุ่มลูกค้า | ประเภท) → db/data/weekly-report-master-groups.json
// ใช้จัดแถว ร้านค้า / เอเย่น ของรายงาน LINE รายสัปดาห์ให้ตรง Excel ฝ่ายขาย (2026-11-25) — lib/weeklySalesReport.js
// ฝ่ายขายแก้มาสเตอร์ไฟล์แล้ว รันใหม่: node scripts/build-weekly-master-groups.js [path.xlsx]  แล้ว restart service
// ไม่มีไลบรารี xlsx ในโปรเจกต์ → แตก zip ด้วย PowerShell (Windows) แล้วอ่าน XML ตรง ๆ

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2] || path.join(__dirname, '..', '..', 'ข้อมูลลูกค้า', 'มาสเตอร์ไฟล์.xlsx');
const OUT = path.join(__dirname, '..', 'db', 'data', 'weekly-report-master-groups.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mastergrp-'));
try {
  const zip = path.join(tmp, 'm.zip');
  fs.copyFileSync(SRC, zip);
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`]);
  const dir = path.join(tmp, 'x', 'xl');
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const ss = [...fs.readFileSync(path.join(dir, 'sharedStrings.xml'), 'utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  // ชีตแรกตามลำดับใน workbook
  const wb = fs.readFileSync(path.join(dir, 'workbook.xml'), 'utf8');
  const rels = fs.readFileSync(path.join(dir, '_rels', 'workbook.xml.rels'), 'utf8');
  const rid = /<sheet [^>]*r:id="([^"]+)"/.exec(wb)[1];
  const rel = [...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
  const target = /Target="([^"]+)"/.exec(rel)[1].replace(/^\/?xl\//, '');
  const xml = fs.readFileSync(path.join(dir, target), 'utf8');
  const out = {};
  let n = 0;
  for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const o = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const v = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/) || (c[3] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (v) o[c[1]] = /t="s"/.test(c[2]) ? ss[Number(v[1])] : unxml(v[1]);
    }
    const code = String(o.A || '').trim(), group = String(o.C || '').trim();
    if (!code || code === 'รหัสลูกค้า' || !group) continue;
    out[code] = group;
    n++;
  }
  fs.writeFileSync(OUT, JSON.stringify({ _source: path.basename(SRC), _built: new Date().toISOString().slice(0, 10), groups: out }, null, 0) + '\n');
  console.log(`wrote ${n} customers → ${OUT}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
