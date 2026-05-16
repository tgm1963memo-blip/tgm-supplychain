-- Migration: เพิ่ม column amount ใน sales_history
-- วิธีใช้: รันใน Supabase SQL Editor แล้วรัน express_sync.py --all อีกครั้ง

ALTER TABLE sales_history
  ADD COLUMN IF NOT EXISTS amount numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN sales_history.amount IS 'มูลค่าขาย (บาท) จาก Express NETVAL';
