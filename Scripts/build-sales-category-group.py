"""สร้าง server/db/data/sales-category-group-20261014.json — Category (Sales) จากคอลัมน์ "Group" ในไฟล์ Group ของเซลล์ (2026-10-14)

ผู้ใช้ขอให้ Category (Sales) ใช้คอลัมน์ Group (Restaurant / Bakery / Hotel / Catering / Retail / Chain Restaurants /
Direct Domestic / Agent Domestic / Food Industry / End User) แทนคอลัมน์ A "กลุ่มลูกค้า" (ร้านค้าทั่วไป / ชื่อห้าง) ของรอบแรก
- อ่านทุกชีตที่มีหัว "รหัสลูกค้า" และ "Group" (หัว Group อาจอยู่แถวบนของหัวรหัส เช่นชีตคุณขนิษฐา)
  รวมชีตสำรอง (คุณปู Sheet1 / คุณแมน GRoups) เพราะชีตหลักของสองคนนี้ไม่มีหัวคอลัมน์ Group
  ระวัง: ชีตหลักคุณปู (คุณลักษณา) มีค่า Group ในคอลัมน์ M แต่หัวว่าง สคริปต์นี้จึงไม่อ่าน — ค่าจริงอยู่ใน data/sales-category-fix-20261105.json
- ค่าไม่ตรงกันระหว่างชีต: ใช้ค่าจากชีต Corporate ก่อน (จัดกลุ่มละเอียดกว่า) ไม่งั้นค่าที่พบมากสุด
- ค่าที่ไม่ใช่ประเภท (หมายเหตุภาษาไทย เช่น "พี่ปูจะย้ายลูกค้ากลับ") / ช่องว่าง = ไม่ใช้
- old_map: ค่ารอบแรกที่แปลงเป็น Group ได้ตรง 100% ในข้อมูล (ห้าง → Retail ฯลฯ) ใช้กับรายที่ไฟล์ไม่มีค่า Group
  "ร้านค้าทั่วไป" แปลงไม่ได้ (กระจายทุกประเภท) → ล้างเป็นว่าง ให้เซลล์กรอกเอง

รัน:  python Scripts/build-sales-category-group.py ["โฟลเดอร์ไฟล์"]   (ไฟล์ที่เปิดค้างใน Excel อ่านไม่ได้ — คัดลอกออกมาก่อน)
"""
import glob
import json
import os
import re
import sys
import warnings
from collections import Counter, defaultdict

import openpyxl

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Template', 'ฝ่ายขายร้านค้า', 'New folder')
OUT = os.path.join(ROOT, 'server', 'db', 'data', 'sales-category-group-20261014.json')

CODE_RE = re.compile(r'^[A-Z0-9]{1,4}-[A-Z0-9]{2}-[A-Z0-9]{2,4}$', re.I)
NORM = {'chain restaurant': 'Chain Restaurants', 'chain restaurants': 'Chain Restaurants'}
OLD_MAP = {
    'เดอะเบเกอรี่ (TOPS)': 'Retail', 'วิลล่า มาร์เก็ท': 'Retail', 'สยามแม็คโคร': 'Retail', 'เดอะมอลล์ กรุ๊ป': 'Retail',
    'บิ๊กซี ซูเปอร์เซ็นเตอร์': 'Retail', 'โลตัส': 'Retail', 'อิออน แผนกเดลิก้า': 'Retail',
    'ไทยยามาซากิ': 'Bakery', 'เซ็นทรัลเรสตอรองส์': 'Chain Restaurants', 'ห้องอาหาร C.D.S.': 'Restaurant',
    'เอเย่นต์ ร้านค้าใบกำกับ': 'Agent Domestic', 'เอเย่นต์ ร้านค้าใบยืม': 'Agent Domestic', 'เอเย่นต์ ร้านค้าเงินสด': 'Agent Domestic',
    'ไดเร็คเซล ร้านค้าใบกำกับ': 'Direct Domestic', 'ไดเร็คเซล ร้านค้าใบยืม': 'Direct Domestic', 'ไดเร็คเซล ร้านค้าเงินสด': 'Direct Domestic',
    'ร้านค้าทั่วไป': None,
}


def is_corp_sheet(title):
    return 'corp' in title.lower() or title == 'ไมเนอร์'


def main():
    found = defaultdict(list)  # code -> [(group, file, sheet, is_corp)]
    junk = Counter()
    for path in sorted(glob.glob(os.path.join(SRC, '*.xlsx'))):
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            rows = [list(r) + [None] * 20 for r in ws.iter_rows(values_only=True)]
            hi = next((i for i, r in enumerate(rows[:6]) if any(str(c or '').strip().startswith('รหัสลูกค้า') for c in r)), None)
            if hi is None:
                continue
            ci = next(j for j, c in enumerate(rows[hi]) if str(c or '').strip().startswith('รหัสลูกค้า'))
            gi = None
            for r in rows[:hi + 1]:
                for j, c in enumerate(r):
                    if str(c or '').strip().lower() == 'group':
                        gi = j
            if gi is None:
                continue
            for x in rows[hi + 1:]:
                code = re.sub(r'\s+', '', str(x[ci] or '')).upper()
                if not CODE_RE.match(code):
                    continue
                v = re.sub(r'\s+', ' ', str(x[gi] or '')).strip()
                v = NORM.get(v.lower(), v)
                if not re.match(r'^[A-Za-z ]+$', v):
                    if v:
                        junk[v] += 1
                    continue
                found[code].append((v, os.path.basename(path), ws.title, is_corp_sheet(ws.title)))
    groups, conflicts = {}, []
    for code, hits in found.items():
        corp = [h[0] for h in hits if h[3]]
        pick = Counter(corp or [h[0] for h in hits]).most_common(1)[0][0]
        groups[code] = pick
        if len({h[0] for h in hits}) > 1:
            conflicts.append({'code': code, 'values': sorted({h[0] for h in hits}), 'used': pick})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'groups': groups, 'old_map': OLD_MAP, 'conflicts': conflicts}, f, ensure_ascii=False, indent=0)
    print(f'customers with Group={len(groups)} conflicts={len(conflicts)} ignored={dict(junk)}')
    print('values', dict(Counter(groups.values())))
    print('wrote', OUT)


if __name__ == '__main__':
    main()
