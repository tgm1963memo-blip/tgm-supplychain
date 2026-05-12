"""
TGM — Step 2: Import Master Data → Supabase
============================================
ไฟล์นี้อ่านข้อมูล master จาก Supply Chain v3 (hardcoded)
แล้ว upsert เข้า Supabase

วิธีใช้:
  pip install supabase
  python step2_import_data.py

ต้องตั้งค่าก่อน:
  SUPABASE_URL = "https://xxxx.supabase.co"
  SUPABASE_KEY = "service_role key" (ไม่ใช่ anon key)
"""

import json
import os
from supabase import create_client, Client

# ============================================================
# CONFIG — แก้ค่านี้ก่อนรัน
# ============================================================
import os
from dotenv import load_dotenv

load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

# ============================================================
# MASTER DATA (copy มาจาก Supply Chain v3 HTML)
# ============================================================

SKUS_MASTER = [
    {"code": "10001", "name": "ค็อกเทลซอสเซส 1000 g. (OFF)",          "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10002", "name": "ค็อกเทลซอสเซส 1000 g.",                 "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10003", "name": "ไส้กรอกค็อกเทลรมควันหนังกรอบ 1000 g.",  "lead_time": 3,  "moq": 0,   "plant": "TGM1"},
    {"code": "10004", "name": "ไส้กรอกค็อกเทลไก่ 1000 g.",             "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10006", "name": "ไส้กรอกค็อกเทล 1000 g.",                "lead_time": 4,  "moq": 130, "plant": "TGM1"},
    {"code": "10008", "name": "แซนวิสแฮม 500 g. TOPS BK",              "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10009", "name": "แซนวิสแฮม (TOPS)",                      "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10011", "name": "แซนวิสแฮม(แท่ง) ซ.ทวี",                "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10012", "name": "สโมคแซนวิสแฮม (ผ่าครึ่ง) TOPS",        "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10013", "name": "ไส้กรอกแฮม 1000 g.",                    "lead_time": 3,  "moq": 0,   "plant": "TGM1"},
    {"code": "10017", "name": "ซาวเออร์เคร้า 1000 g.",                 "lead_time": 15, "moq": 50,  "plant": "TGM1"},
    {"code": "10019", "name": "บาโลน่าไก่ (แท่ง)",                     "lead_time": 5,  "moq": 70,  "plant": "TGM1"},
    {"code": "10021", "name": "บาโลน่าพริกไก่ (แท่ง)",                 "lead_time": 5,  "moq": 70,  "plant": "TGM1"},
    {"code": "10022", "name": "บาโลน่าพริก 1000 g.",                   "lead_time": 4,  "moq": 140, "plant": "TGM1"},
    {"code": "10023", "name": "บาโลน่าพริก (แท่ง)",                    "lead_time": 5,  "moq": 70,  "plant": "TGM1"},
    {"code": "10025", "name": "บาโลน่า 1000 g.",                       "lead_time": 4,  "moq": 120, "plant": "TGM1"},
    {"code": "10026", "name": "บาโลน่า (แท่ง)",                        "lead_time": 5,  "moq": 70,  "plant": "TGM1"},
    {"code": "10027", "name": "บาโลน่า (บาง) 1000 g.",                 "lead_time": 4,  "moq": 120, "plant": "TGM1"},
    {"code": "10028", "name": "สโมคเบค่อน (คัดพิเศษ) 1000 g.",        "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10029", "name": "สโมคเบค่อน(บิท) 1000 g.",              "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10030", "name": "สโมคเบค่อน (แผ่น)",                     "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10032", "name": "แซนวิสแฮม(บิท) 1000 g.",               "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10037", "name": "สโมคเบค่อน 1000 g. BBQ PLAZA",         "lead_time": 10, "moq": 0,   "plant": "TGM2"},
    {"code": "10046", "name": "แฟร้งเฟิตเตอร์(4.5 นิ้ว) 1000 g.",    "lead_time": 3,  "moq": 0,   "plant": "TGM1"},
    {"code": "10053", "name": "ฮอทดอกรมควัน 1000 g.",                  "lead_time": 3,  "moq": 120, "plant": "TGM1"},
    {"code": "10057", "name": "สโมคแฮม (ชิ้น)",                       "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10059", "name": "ไส้กรอก 3 นิ้ว 500 g.",                 "lead_time": 4,  "moq": 130, "plant": "TGM1"},
    {"code": "10062", "name": "ไส้กรอกเบรคฟัสรมควัน 1000 g.",         "lead_time": 4,  "moq": 130, "plant": "TGM1"},
    {"code": "10063", "name": "สโมคซอสเซส 4 นิ้ว 1000 g.",            "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10070", "name": "ไส้กรอก 5 นิ้ว 1000 g.",                "lead_time": 4,  "moq": 130, "plant": "TGM1"},
    {"code": "10071", "name": "ไส้กรอกแฟร้งเฟิตเตอร์ไก่ 1000 g.",    "lead_time": 3,  "moq": 0,   "plant": "TGM1"},
    {"code": "10072", "name": "ไส้กรอกรมควัน 5 นิ้ว 1000 g.",         "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10083", "name": "คุ๊กแฮม 1000 g.",                       "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10085", "name": "แซนวิสแฮม 500 g. เดริก้า",             "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10086", "name": "คุ๊กแฮม 1000 g. Farmhouse",             "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10093", "name": "สโมคเบค่อนไดซ์ 1000 g.",               "lead_time": 7,  "moq": 100, "plant": "TGM2"},
    {"code": "10154", "name": "สโมคเบค่อน 1000 g. M.MAR",             "lead_time": 10, "moq": 0,   "plant": "TGM2"},
    {"code": "10163", "name": "ไส้กรอกจูเนียร์ 1000 g.",               "lead_time": 4,  "moq": 0,   "plant": "TGM1"},
    {"code": "10165", "name": "แฮม 4x4 (ชิ้น)",                       "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10169", "name": "ไส้กรอก 3 นิ้ว (เล็ก) 1000 g.",        "lead_time": 4,  "moq": 130, "plant": "TGM1"},
    {"code": "10201", "name": "สโมคเบค่อน(แผ่นสั้น) 1000 g.",         "lead_time": 7,  "moq": 0,   "plant": "TGM2"},
    {"code": "10209", "name": "ไส้กรอกไก่บิท 1000 g.",                 "lead_time": 7,  "moq": 0,   "plant": "TGM1"},
    # ... เพิ่มรายการที่เหลือจาก SKUS_MASTER ใน HTML
]

# SKU group mapping
SKU_GROUPS = {
    "ไส้กรอก": ["10002","10003","10004","10006","10013","10059","10062","10063",
                 "10070","10071","10072","10163","10169","10209"],
    "แฮม":     ["10008","10009","10011","10012","10032","10083","10085","10086",
                 "10165"],
    "เบค่อน":  ["10028","10029","10030","10037","10093","10154","10201"],
    "อื่นๆ":   ["10017","10046","10053","10057"],
}

# ลูกค้าตัวอย่าง (เพิ่มจาก CUST_NAMES ใน HTML)
CUSTOMERS_SAMPLE = [
    {"code": "30-LA-0050", "name": "ฟู้ดแพชชั่นจำกัด",          "slm_id": "104"},
    {"code": "30-LA-0073", "name": "ซีแอนด์ดับบลิวอินเตอร์ฟูดส์", "slm_id": "105"},
    {"code": "30-TA-0001", "name": "เซ็นทรัลฟู้ดรีเทลจำกัด",    "slm_id": "106"},
    {"code": "30-LA-0074", "name": "แกรนด์อินเตอร์ฟูดส์จำกัด",  "slm_id": "103"},
    {"code": "LA-30-0004", "name": "ภูเก็ตฟู้ดแอนด์ซอสเซส",     "slm_id": "114"},
    # ... เพิ่มจาก CUST_NAMES ใน HTML ทั้งหมด
]


# ============================================================
# IMPORT FUNCTIONS
# ============================================================

def import_products(sb: Client):
    """Import SKUS_MASTER → products table"""
    print("\n[1/5] Importing products...")
    
    rows = []
    for sku in SKUS_MASTER:
        # หา group name
        group = "อื่นๆ"
        for g, codes in SKU_GROUPS.items():
            if sku["code"] in codes:
                group = g
                break
        
        # หา shelf_life จากชื่อสินค้า
        shelf_life = 30
        if "แช่แข็ง" in sku["name"] or "-7" in sku["code"]:
            shelf_life = 180
        
        rows.append({
            "code":       sku["code"],
            "name":       sku["name"],
            "group_name": group,
            "lead_time":  sku["lead_time"],
            "moq":        sku["moq"],
            "min_stock":  max(sku["moq"] or 30, 30),
            "shelf_life": shelf_life,
            "plant":      sku["plant"],
            "is_active":  True,
        })
    
    # upsert ทีละ 50 แถว
    batch_size = 50
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        result = sb.table("products").upsert(batch).execute()
        print(f"  ✓ batch {i//batch_size + 1}: {len(batch)} products")
    
    print(f"  → Total: {len(rows)} products imported")


def import_customers(sb: Client):
    """Import CUST_NAMES → customers table"""
    print("\n[2/5] Importing customers...")
    
    # ดึง CUST_NAMES จาก HTML มาใส่ที่นี่ก่อน
    # ตัวอย่างนี้ใช้ CUSTOMERS_SAMPLE
    rows = []
    for c in CUSTOMERS_SAMPLE:
        rows.append({
            "code":      c["code"],
            "name":      c["name"],
            "slm_id":    c.get("slm_id"),
            "is_active": True,
        })
    
    if rows:
        result = sb.table("customers").upsert(rows).execute()
        print(f"  → {len(rows)} customers imported")
    else:
        print("  ⚠ ไม่มีข้อมูลลูกค้า — เพิ่ม CUSTOMERS ก่อน")


def import_sales_history(sb: Client, slm_hist: dict, slm_id: str):
    """Import SLM_HIST หรือ ALL_HIST → sales_history table"""
    print(f"\n[3/5] Importing sales_history for slm_id={slm_id}...")
    
    rows = []
    for sku_code, data in slm_hist.items():
        for ym, qty in data.get("monthly", {}).items():
            if qty > 0:
                rows.append({
                    "slm_id": slm_id,
                    "sku":    sku_code,
                    "ym":     ym,
                    "qty":    qty,
                })
    
    # upsert ทีละ 200
    batch_size = 200
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        sb.table("sales_history").upsert(batch).execute()
    
    print(f"  → {len(rows)} records for slm_id={slm_id}")


def import_sku_settings(sb: Client):
    """สร้าง default sku_settings จาก products"""
    print("\n[4/5] Creating sku_settings...")
    
    # ดึง products ทั้งหมด
    result = sb.table("products").select("code,lead_time,moq,shelf_life").execute()
    products = result.data
    
    rows = []
    for p in products:
        rows.append({
            "sku":       p["code"],
            "min_stock": max(p.get("moq") or 30, 30),
            "shelf_life": p.get("shelf_life") or 30,
            "moq":       p.get("moq") or 0,
            "lead_time": p.get("lead_time") or 7,
        })
    
    if rows:
        sb.table("sku_settings").upsert(rows).execute()
        print(f"  → {len(rows)} sku_settings created")


def verify_import(sb: Client):
    """ตรวจสอบว่า import สำเร็จ"""
    print("\n[5/5] Verifying import...")
    
    checks = [
        ("products",      "code"),
        ("customers",     "code"),
        ("sales_history", "id"),
        ("sc_users",      "uid"),
        ("sku_settings",  "sku"),
    ]
    
    for table, col in checks:
        result = sb.table(table).select(col, count="exact").execute()
        count = result.count if hasattr(result, 'count') else len(result.data)
        print(f"  {'✓' if count > 0 else '✗'} {table}: {count} rows")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    print("=" * 50)
    print("TGM Data Import — Supabase")
    print("=" * 50)
    
    # เชื่อม Supabase
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    print(f"✓ Connected to Supabase: {SUPABASE_URL}")
    
    # 1. Import products
    import_products(sb)
    
    # 2. Import customers
    import_customers(sb)
    
    # 3. Import ALL_HIST (ใส่ข้อมูลจาก HTML ก่อน)
    # ALL_HIST = {...}  ← copy มาจาก HTML
    # import_sales_history(sb, ALL_HIST, "ALL")
    
    # 4. Import แต่ละ Sales
    # SLM_HIST = {...}  ← copy มาจาก HTML
    # for slm_id, hist in SLM_HIST.items():
    #     import_sales_history(sb, hist, slm_id)
    
    # 5. Create sku_settings
    import_sku_settings(sb)
    
    # 6. Verify
    verify_import(sb)
    
    print("\n✓ Import complete!")
    print("\nNext steps:")
    print("  - รัน step3_migrate_html.py")
    print("  - หรือเปิด Supply Chain HTML แล้วเริ่ม test")
