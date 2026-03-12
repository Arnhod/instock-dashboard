-- supabase/schema.sql
-- Instock WMS Dashboard — Supabase tables
-- Kjør dette i Supabase SQL Editor før første sync.
-- ─────────────────────────────────────────────────────────

-- ── 1. Customer config ──────────────────────────────────
CREATE TABLE IF NOT EXISTS wms_config (
  id              text PRIMARY KEY DEFAULT 'default',
  customer_name   text,
  customer_short  text,
  primary_color   text,
  zones           jsonb,   -- array of { id, name, color, hot }
  hot_zone_ids    jsonb,   -- array of zone id strings
  cold_status_ids jsonb,   -- array of status id integers
  updated_at      timestamptz DEFAULT now()
);

-- ── 2. Zone stats (pick activity per zone, last 7 days) ─
CREATE TABLE IF NOT EXISTS wms_zone_stats (
  zone_id          text PRIMARY KEY,
  zone_name        text,
  total_locations  int,
  products_in_zone int,
  total_stock      bigint,
  pick_count       int,
  active_products  int,
  updated_at       timestamptz DEFAULT now()
);

-- ── 3. Hotzone — top 20 products by pick frequency ──────
CREATE TABLE IF NOT EXISTS wms_hotzone_items (
  product_id         bigint PRIMARY KEY,
  sku                text,
  product_name       text,
  qty_in_stock       int,
  status_name        text,
  status_id          int,
  current_location   text,
  current_zone_id    text,
  current_zone_name  text,
  pick_count         int,
  in_hot_zone        int,
  misplaced          int,
  updated_at         timestamptz DEFAULT now()
);

-- ── 4. Move candidates — cold products in hot zone ──────
CREATE TABLE IF NOT EXISTS wms_move_candidates (
  product_id         bigint PRIMARY KEY,
  sku                text,
  product_name       text,
  status_name        text,
  status_id          int,
  current_location   text,
  current_zone_id    text,
  current_zone_name  text,
  qty_in_stock       int,
  last_movement      timestamptz,
  updated_at         timestamptz DEFAULT now()
);

-- ── 5. Picklist pipeline counts (last 24h) ───────────────
CREATE TABLE IF NOT EXISTS wms_pipeline (
  status      text PRIMARY KEY,
  count       int,
  updated_at  timestamptz DEFAULT now()
);

-- ── 6. Active picklists (OPEN + STARTED) ────────────────
CREATE TABLE IF NOT EXISTS wms_active_picklists (
  picklist_id        int PRIMARY KEY,
  status             text,
  created_time       timestamptz,
  modified_time      timestamptz,
  shortage           int,
  operator_name      text,
  operator_username  text,
  operator_id        int,
  total_lines        int,
  finished_lines     int,
  shortage_lines     int,
  order_ref          text,
  zones              text,
  updated_at         timestamptz DEFAULT now()
);

-- ── 7. Operators — activity for today ───────────────────
CREATE TABLE IF NOT EXISTS wms_operators_today (
  operator_id         int PRIMARY KEY,
  operator_name       text,
  username            text,
  pick_count          int,
  receive_count       int,
  return_count        int,
  move_count          int,
  total_transactions  int,
  pick_pct            int,
  receive_pct         int,
  return_pct          int,
  move_pct            int,
  updated_at          timestamptz DEFAULT now()
);

-- ── 8. Mottak — goods received today ────────────────────
CREATE TABLE IF NOT EXISTS wms_mottak_today (
  id                bigint PRIMARY KEY,
  created_time      timestamptz,
  quantity          int,
  location_id       text,
  location_from_id  text,
  product_name      text,
  sku               text,
  operator_name     text,
  updated_at        timestamptz DEFAULT now()
);

-- ── 9. Activity feed — recent transactions (24h) ────────
CREATE TABLE IF NOT EXISTS wms_activity_feed (
  id                bigint PRIMARY KEY,
  created_time      timestamptz,
  quantity          int,
  location_id       text,
  location_from_id  text,
  status            text,
  product_name      text,
  sku               text,
  operator_name     text,
  zone_id           text,
  zone_name         text,
  transaction_type  text,
  updated_at        timestamptz DEFAULT now()
);

-- ── 10. Sync log ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wms_sync_log (
  id          bigserial PRIMARY KEY,
  synced_at   timestamptz DEFAULT now(),
  status      text,
  duration_ms int,
  error       text
);

-- ─────────────────────────────────────────────────────────
-- Row Level Security — allow public read (anon key)
-- Service key bypasses RLS for writes.
-- ─────────────────────────────────────────────────────────

ALTER TABLE wms_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_zone_stats       ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_hotzone_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_move_candidates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_pipeline         ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_active_picklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_operators_today  ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_mottak_today     ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_activity_feed    ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_sync_log         ENABLE ROW LEVEL SECURITY;

-- Read-only for anon (dashboard uses anon key)
CREATE POLICY "public read" ON wms_config           FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_zone_stats       FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_hotzone_items    FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_move_candidates  FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_pipeline         FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_active_picklists FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_operators_today  FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_mottak_today     FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_activity_feed    FOR SELECT USING (true);
CREATE POLICY "public read" ON wms_sync_log         FOR SELECT USING (true);

-- ─────────────────────────────────────────────────────────
-- Helper function used by sync script to clear tables
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION truncate_wms_table(tname text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  allowed text[] := ARRAY[
    'wms_zone_stats', 'wms_hotzone_items', 'wms_move_candidates',
    'wms_pipeline', 'wms_active_picklists', 'wms_operators_today',
    'wms_mottak_today', 'wms_activity_feed'
  ];
BEGIN
  IF tname = ANY(allowed) THEN
    EXECUTE 'DELETE FROM ' || tname;
  ELSE
    RAISE EXCEPTION 'Table not allowed: %', tname;
  END IF;
END;
$$;
