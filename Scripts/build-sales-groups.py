"""สร้าง server/db/data/sales-groups-20261012.json จากไฟล์ Group ของเซลล์ฝ่ายขายร้านค้า (2026-10-12)

ไฟล์ต้นทาง: Template/ฝ่ายขายร้านค้า/New folder/Group <เซลล์> <วันที่>.xlsx
- ชีตหลักของเซลล์: คอลัมน์ A "กลุ่มลูกค้า" = Category (Sales) — ค่าอยู่ที่แถวแรกของบล็อก แถวล่างว่าง (ใช้ค่าล่าสุด)
- ชีต Corporate: กลุ่มลูกค้า (Sales) — มีเลข 1,2,3 ในคอลัมน์ A = เริ่มกลุ่มใหม่ · ไม่มีเลข = จับกลุ่มตามชื่อบริษัท
  ชื่อกลุ่ม = "หมายเหตุ Corporate" ถ้ามี ไม่มี = ชื่อบริษัทของลูกค้ารายแรกในกลุ่ม (ตัดเลขสาขา/จำกัด)
- ลูกค้าที่ไม่อยู่ในชีต Corporate = ไม่มีกลุ่ม

รัน:  python scripts/build-sales-groups.py   (ต้องมี openpyxl)
"""
import glob
import json
import os
import re
import sys
import warnings
from collections import Counter, OrderedDict

import openpyxl

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'Template', 'ฝ่ายขายร้านค้า', 'New folder')
OUT = os.environ.get('SALES_GROUPS_OUT') or os.path.join(ROOT, 'server', 'db', 'data', 'sales-groups-20261012.json')

# ท้ายรหัส 2 ตัวด้วย (TNA-01-KK, OIS-01-KF ฯลฯ — เดิม {3,4} ทำ 7 ลูกค้าตกหล่น, แก้ 2026-10-14)
CODE_RE = re.compile(r'^[A-Z0-9]{1,4}-[A-Z0-9]{2}-[A-Z0-9]{2,4}$', re.I)
# ชีตที่ซ้ำกับชีตหลัก / ชีตสรุป — ไม่ใช้
SKIP_SHEETS = {('Group คุณปู', 'Sheet1'), ('Group คุณแมน', 'GRoups'), ('Group คุณฐา', 'Sheet3'), ('Group คุณฐา', 'Sheet1 (2)')}


def clean(v):
    return re.sub(r'\s+', ' ', str(v or '').replace('\xa0', ' ')).strip()


def company_name(name):
    """ชื่อบริษัทสำหรับจับกลุ่ม/ตั้งชื่อกลุ่ม: ตัดลำดับนำหน้า, วงเล็บ, จำกัด/มหาชน/บริษัท, เลขสาขาท้ายชื่อ"""
    s = clean(name)
    s = re.sub(r'^\s*\d+\s*\.\s*', '', s)
    s = re.sub(r'\([^)]*\)', ' ', s)
    s = re.sub(r'บริษัท|\bบจ\.|จำกัด|มหาชน', ' ', s)
    s = re.sub(r'(\s+\d+)+\s*$', '', clean(s))
    return clean(s)


def header_index(rows):
    """แถวหัวตาราง (มีคำว่า รหัสลูกค้า) → (index แถว, คอลัมน์รหัส, คอลัมน์ชื่อ, คอลัมน์หมายเหตุ)"""
    for i, r in enumerate(rows[:6]):
        cells = [clean(c) for c in r]
        if any(c.startswith('รหัสลูกค้า') for c in cells):
            code = next(j for j, c in enumerate(cells) if c.startswith('รหัสลูกค้า'))
            name = next((j for j, c in enumerate(cells) if c.startswith('ชื่อร้านค้า') or c.startswith('ชื่อลูกค้า')), code + 1)  # ไม่มีหัว = คอลัมน์ถัดจากรหัส
            # หัวคอลัมน์หมายเหตุสะกดต่างกันทุกไฟล์: "หมายเหตุ Corporate" / "หมายเหตุcorporate" (ไม่มีวรรค — ไฟล์คุณเชล)
            # / "หมายเหตุ corperate" / "หมายเหตุ Cororate" — เดิมเช็ค startswith('หมายเหตุ corp') ทำให้ 3 ชีตไม่เจอคอลัมน์นี้ (2026-10-19)
            # เลือกคอลัมน์ "หมายเหตุ …cor…" ก่อน (กันชีตที่มีคอลัมน์หมายเหตุทั่วไปอีกคอลัมน์ — code review) ไม่มีจึงใช้ "หมายเหตุ" เฉยๆ
            notes = [j for j, c in enumerate(cells) if c.replace(' ', '').startswith('หมายเหตุ')]
            note = next((j for j in notes if 'co' in cells[j].lower()), notes[0] if notes else None)
            return i, code, name, note
    return None


def file_key(path):
    base = os.path.basename(path)
    return re.sub(r'\s+[\d.]+\.xlsx$', '', base)


def is_corp_sheet(title):
    t = title.lower()
    return 'corp' in t or title == 'ไมเนอร์'


def main():
    cat = OrderedDict()     # code -> (category, by)
    grp = OrderedDict()     # code -> (group name, by)
    conflicts = []
    pending = []    # (group, by) — ตั้งชื่อตอนท้าย
    stats = []
    for path in sorted(glob.glob(os.path.join(SRC, '*.xlsx'))):
        fk = file_key(path)
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            if (fk, ws.title) in SKIP_SHEETS:
                continue
            rows = [list(r) + [None] * 14 for r in ws.iter_rows(values_only=True)]
            hi = header_index(rows)
            if not hi:
                continue
            h, ci, ni, noi = hi
            seller = clean(rows[0][1]) if clean(rows[0][0]) == 'พนักงานขาย' else ''
            by = seller or fk.replace('Group ', '')
            data = [r for r in rows[h + 1:] if CODE_RE.match(clean(r[ci]))]
            if not is_corp_sheet(ws.title):
                cur = None
                for r in data:
                    a = clean(r[0])
                    if a and not a.endswith('ผลรวม'):
                        cur = a
                    code = clean(r[ci]).upper()
                    if cur:
                        if code in cat and cat[code][0] != cur:
                            conflicts.append(('category', code, cat[code], (cur, by)))
                        cat[code] = (cur, by)
                stats.append((fk, ws.title, 'category', len(data)))
                continue
            # ชีต Corporate
            numbered = any(isinstance(r[0], (int, float)) for r in data)
            # ชีตไม่มีเลขกลุ่มแต่มีคอลัมน์หมายเหตุ (ไฟล์คุณเชล ฯลฯ): แถวที่มีหมายเหตุ = เริ่มบล็อกใหม่ แถวถัดไปที่หมายเหตุว่าง
            # อยู่บล็อกเดียวกันจนเจอหมายเหตุถัดไป (เช่น Kenshin Izakaya = 30-LG-0034…0047 รวมเคนโซ) — 2026-10-19
            noted = not numbered and noi is not None and any(clean(r[noi]) for r in data)
            groups = OrderedDict()  # key -> {'codes': [], 'note': '', 'first': ''}
            cur = None
            block, last_no = 0, 0   # ชีตที่เริ่มเลขกลุ่มใหม่ (1,2,…,6 แล้ว 1,2,…) = บล็อกใหม่ — ไม่รวมกลุ่มเลขเดียวกันข้ามบล็อก (2026-10-14)
            for r in data:
                code = clean(r[ci]).upper()
                name = clean(r[ni]) if ni is not None else ''
                note = clean(r[noi]) if noi is not None else ''
                if numbered:
                    if isinstance(r[0], (int, float)):
                        if int(r[0]) <= last_no:
                            block += 1
                        last_no = int(r[0])
                        cur = f'{ws.title}#{block}.{int(r[0])}'
                    key = cur or f'{ws.title}#0'
                elif noted:
                    if note:
                        block += 1
                        cur = f'{ws.title}#n{block}'
                    key = cur or (company_name(name) or code)  # แถวก่อนหมายเหตุแรก = จับตามชื่อบริษัทเหมือนเดิม
                else:
                    key = company_name(name) or code
                g = groups.setdefault(key, {'codes': [], 'note': '', 'names': []})
                g['codes'].append(code)
                if note and not g['note']:
                    g['note'] = note.strip(' /')   # "TAHONA/" → "TAHONA"
                if name:
                    g['names'].append(name)
            pending.extend((g, by) for g in groups.values())  # ตั้งชื่อหลังอ่าน category ครบทุกชีต
            stats.append((fk, ws.title, f'groups={len(groups)}', len(data)))

    # ชื่อกลุ่ม: หมายเหตุ Corporate → category เดียวกันทั้งกลุ่ม (ไม่ใช่ร้านค้าทั่วไป) → ชื่อบริษัทที่พบบ่อยสุด → ชื่อรายแรก
    for g, by in pending:
        cats = {cat[c][0] for c in g['codes'] if c in cat}
        common = Counter(company_name(n) for n in g['names'] if company_name(n)).most_common(1)
        gname = (g['note'] or (next(iter(cats)) if len(cats) == 1 and next(iter(cats)) != 'ร้านค้าทั่วไป' else '')
                 or (common[0][0] if common else '') or g['codes'][0])
        for code in g['codes']:
            if code in grp and grp[code][0] != gname:
                conflicts.append(('group', code, grp[code], (gname, by)))
            grp[code] = (gname, by)

    codes = list(OrderedDict.fromkeys(list(cat.keys()) + list(grp.keys())))
    out = []
    for code in codes:
        c = cat.get(code)
        g = grp.get(code)
        out.append({'code': code, 'sales_category': c[0] if c else None, 'sales_group': g[0] if g else None,
                    'by': (c or g)[1]})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=0)

    for s in stats:
        print('  ', *s)
    print(f'customers={len(out)} with_category={sum(1 for x in out if x["sales_category"])} '
          f'with_group={sum(1 for x in out if x["sales_group"])} '
          f'categories={len({x["sales_category"] for x in out if x["sales_category"]})} '
          f'groups={len({x["sales_group"] for x in out if x["sales_group"]})}')
    print(f'conflicts={len(conflicts)} (ใช้ค่าจากไฟล์หลังสุด)')
    for c in conflicts[:40]:
        print('  ', c)
    print('wrote', OUT)


if __name__ == '__main__':
    main()
