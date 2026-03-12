// sync/index.js — Instock WMS Sync Job
// Reads from Azure SQL (Instock) → writes to Supabase
// Run: node index.js  |  or via GitHub Actions cron
require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

// ── Customer config from environment variables ──────────
const customer = {
  name:         process.env.CUSTOMER_NAME  || 'Instock WMS',
  shortName:    process.env.CUSTOMER_SHORT || 'WMS',
  primaryColor: process.env.CUSTOMER_COLOR || '#4f6ef7',
};

const zones         = JSON.parse(process.env.ZONES_JSON || '[]');
const coldStatusIds = (process.env.COLD_STATUS_IDS || '2,6,9,12').split(',').map(Number);
const systemLocs    = (process.env.SYSTEM_LOCATIONS || 'MOTTAK,Bermuda').split(',').map(s => s.trim());
const warehouseId   = process.env.WAREHOUSE_ID ? Number(process.env.WAREHOUSE_ID) : null;

if (!zones.length) {
  console.error('❌  ZONES_JSON is empty — set it in .env or GitHub Secrets');
  process.exit(1);
}

// ── SQL fragments (built once at startup) ───────────────
const ALL_ZONE_IDS = zones.map(z => `'${z.id}'`).join(',');
const HOT_ZONE_IDS = zones.filter(z => z.hot).map(z => `'${z.id}'`).join(',');
const COLD_IDS_SQL = coldStatusIds.join(',');
const SYS_LOCS_SQL = systemLocs.map(l => `'${l}'`).join(',');
const wh = (alias) => warehouseId ? `AND ${alias}.WAREHOUSE_ID = ${warehouseId}` : '';

// ── Azure SQL connection ─────────────────────────────────
const dbConfig = {
  server:   process.env.DB_SERVER,
  port:     parseInt(process.env.DB_PORT) || 3342,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  requestTimeout: 60000,  // 60 seconds per query (default 15s is too short)
  options: {
    encrypt:               true,
    trustServerCertificate: true,
    enableArithAbort:      true,
  },
};

// ── Supabase client (service key bypasses RLS for writes) ─
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ──────────────────────────────────────────────
async function upsert(table, rows, conflictCol = 'id') {
  if (!rows || rows.length === 0) {
    console.log(`  — ${table}: ingen rader`);
    return;
  }
  const { error } = await supabase.from(table).upsert(rows, { onConflict: conflictCol });
  if (error) throw new Error(`upsert ${table}: ${error.message}`);
  console.log(`  ✓ ${table} — ${rows.length} rader`);
}

// Delete rows whose PK is no longer in the new dataset
async function deleteStale(table, pkCol, currentIds) {
  if (!currentIds || currentIds.length === 0) {
    // No new rows → clear entire table
    await supabase.from(table).delete().gte(pkCol, 0);
    return;
  }
  const { error } = await supabase
    .from(table)
    .delete()
    .not(pkCol, 'in', `(${currentIds.join(',')})`);
  if (error) console.warn(`  ⚠ deleteStale ${table}: ${error.message}`);
}

// ─────────────────────────────────────────────────────────
async function syncAll() {
  const startMs  = Date.now();
  const now      = new Date().toISOString();
  const today    = now.split('T')[0];

  console.log(`\n🔄  Starter sync — ${now}`);

  const pool = await sql.connect(dbConfig);
  console.log('✅  Tilkoblet Azure SQL');

  // ── 1. Config ──────────────────────────────────────────
  const { error: cfgErr } = await supabase.from('wms_config').upsert([{
    id:              'default',
    customer_name:   customer.name,
    customer_short:  customer.shortName,
    primary_color:   customer.primaryColor,
    zones:           zones,
    hot_zone_ids:    zones.filter(z => z.hot).map(z => z.id),
    cold_status_ids: coldStatusIds,
    updated_at:      now,
  }]);
  if (cfgErr) throw new Error(`upsert wms_config: ${cfgErr.message}`);
  console.log('  ✓ wms_config');

  // ── 2. Zone stats ──────────────────────────────────────
  const zoneRes = await pool.request()
    .input('days', sql.Int, 7)
    .query(`
      SELECT
        z.ZONE_ID,
        z.NAME                          AS zone_name,
        COUNT(DISTINCT l.LOCATION_ID)   AS total_locations,
        COUNT(DISTINCT s.PRODUCT_ID)    AS products_in_zone,
        COALESCE(SUM(s.QUANTITY), 0)    AS total_stock,
        COALESCE(t.pick_count, 0)       AS pick_count,
        COALESCE(t.unique_products, 0)  AS active_products
      FROM wms_zone z
      LEFT JOIN wms_location l
        ON l.ZONE_ID = z.ZONE_ID AND l.ACTIVE = 1 ${wh('l')}
      LEFT JOIN wms_stock s
        ON s.LOCATION_ID = l.LOCATION_ID AND s.WAREHOUSE_ID = l.WAREHOUSE_ID
      LEFT JOIN (
        SELECT loc.ZONE_ID,
               COUNT(tr.ID)                  AS pick_count,
               COUNT(DISTINCT tr.PRODUCT_ID) AS unique_products
        FROM wms_transaction tr
        JOIN wms_location loc ON loc.LOCATION_ID = tr.LOCATION_FROM_ID
        WHERE tr.STATUS = 'CLOSED'
          AND tr.LOCATION_FROM_ID IS NOT NULL
          AND tr.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
          AND tr.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
          ${wh('tr')}
        GROUP BY loc.ZONE_ID
      ) t ON t.ZONE_ID = z.ZONE_ID
      WHERE z.ZONE_ID IN (${ALL_ZONE_IDS})
      GROUP BY z.ZONE_ID, z.NAME, t.pick_count, t.unique_products
      ORDER BY COALESCE(t.pick_count, 0) DESC
    `);

  await upsert('wms_zone_stats', zoneRes.recordset.map(z => ({
    zone_id:          z.ZONE_ID,
    zone_name:        z.zone_name,
    total_locations:  z.total_locations,
    products_in_zone: z.products_in_zone,
    total_stock:      z.total_stock,
    pick_count:       z.pick_count,
    active_products:  z.active_products,
    updated_at:       now,
  })), 'zone_id');

  // ── 3. Hotzone — top 20 products ───────────────────────
  const hzRes = await pool.request()
    .input('days',  sql.Int, 7)
    .input('limit', sql.Int, 20)
    .query(`
      SELECT TOP (@limit)
        p.ID              AS product_id,
        p.PRODUCT_NO      AS sku,
        p.NAME            AS product_name,
        p.QTY_IN_STOCK    AS qty_in_stock,
        ps.NAME           AS status_name,
        ps.ID             AS status_id,
        l.LOCATION_ID     AS current_location,
        l.ZONE_ID         AS current_zone_id,
        z.NAME            AS current_zone_name,
        COUNT(t.ID)       AS pick_count,
        CASE WHEN l.ZONE_ID IN (${HOT_ZONE_IDS}) THEN 1 ELSE 0 END AS in_hot_zone,
        CASE WHEN l.ZONE_ID NOT IN (${HOT_ZONE_IDS}) THEN 1 ELSE 0 END AS misplaced
      FROM wms_transaction t
      JOIN wms_product p       ON p.ID = t.PRODUCT_ID
      JOIN wms_location l      ON l.LOCATION_ID = t.LOCATION_FROM_ID
      LEFT JOIN wms_zone z     ON z.ZONE_ID = l.ZONE_ID
      LEFT JOIN wms_product_status ps ON ps.ID = p.STATUS_CODE_ID
      WHERE t.STATUS = 'CLOSED'
        AND t.LOCATION_FROM_ID IS NOT NULL
        AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
        AND t.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
        ${wh('t')}
      GROUP BY p.ID, p.PRODUCT_NO, p.NAME, p.QTY_IN_STOCK,
               ps.NAME, ps.ID, l.LOCATION_ID, l.ZONE_ID, z.NAME
      ORDER BY pick_count DESC
    `);

  // Deduplicate by product_id — a product may appear in multiple locations;
  // keep the first occurrence (highest pick_count since ordered DESC)
  const hzSeen = new Set();
  const hzRows = hzRes.recordset
    .filter(it => { if (hzSeen.has(it.product_id)) return false; hzSeen.add(it.product_id); return true; })
    .map(it => ({
    product_id:        it.product_id,
    sku:               it.sku,
    product_name:      it.product_name,
    qty_in_stock:      it.qty_in_stock,
    status_name:       it.status_name,
    status_id:         it.status_id,
    current_location:  it.current_location,
    current_zone_id:   it.current_zone_id,
    current_zone_name: it.current_zone_name,
    pick_count:        it.pick_count,
    in_hot_zone:       it.in_hot_zone,
    misplaced:         it.misplaced,
    updated_at:        now,
  }));

  await upsert('wms_hotzone_items', hzRows, 'product_id');
  await deleteStale('wms_hotzone_items', 'product_id', hzRows.map(r => r.product_id));

  // ── 4. Move candidates ─────────────────────────────────
  const mcRes = await pool.request().query(`
    SELECT
      p.ID              AS product_id,
      p.PRODUCT_NO      AS sku,
      p.NAME            AS product_name,
      ps.NAME           AS status_name,
      ps.ID             AS status_id,
      s.LOCATION_ID     AS current_location,
      l.ZONE_ID         AS current_zone_id,
      z.NAME            AS current_zone_name,
      s.QUANTITY        AS qty_in_stock,
      (
        SELECT MAX(tr.CREATED_TIME)
        FROM wms_transaction tr
        WHERE tr.PRODUCT_ID = p.ID
          AND tr.STATUS = 'CLOSED'
          AND tr.LOCATION_FROM_ID IS NOT NULL
      ) AS last_movement
    FROM wms_stock s
    JOIN wms_product p        ON p.ID = s.PRODUCT_ID
    JOIN wms_product_status ps ON ps.ID = p.STATUS_CODE_ID
    JOIN wms_location l       ON l.LOCATION_ID = s.LOCATION_ID ${wh('l')}
    LEFT JOIN wms_zone z      ON z.ZONE_ID = l.ZONE_ID
    WHERE ps.ID IN (${COLD_IDS_SQL})
      AND l.ZONE_ID IN (${HOT_ZONE_IDS})
      AND s.QUANTITY > 0
    ORDER BY ps.ID, s.QUANTITY DESC
  `);

  const mcSeen = new Set();
  const mcRows = mcRes.recordset
    .filter(it => { if (mcSeen.has(it.product_id)) return false; mcSeen.add(it.product_id); return true; })
    .map(it => ({
    product_id:        it.product_id,
    sku:               it.sku,
    product_name:      it.product_name,
    status_name:       it.status_name,
    status_id:         it.status_id,
    current_location:  it.current_location,
    current_zone_id:   it.current_zone_id,
    current_zone_name: it.current_zone_name,
    qty_in_stock:      it.qty_in_stock,
    last_movement:     it.last_movement,
    updated_at:        now,
  }));

  await upsert('wms_move_candidates', mcRows, 'product_id');
  await deleteStale('wms_move_candidates', 'product_id', mcRows.map(r => r.product_id));

  // ── 5. Pipeline + active picklists ─────────────────────
  const pipeRes = await pool.request().query(`
    SELECT STATUS, COUNT(*) AS count
    FROM wms_picklist
    WHERE CAST(CREATED_TIME AS DATE) = CAST(GETDATE() AS DATE)
      AND STATUS IN ('OPEN','STARTED','FINISHED')
    GROUP BY STATUS
  `);

  // Clear and rewrite pipeline counts so stale data never lingers
  await supabase.from('wms_pipeline').delete().neq('status', '');
  const { error: plErr } = await supabase.from('wms_pipeline').insert(
    pipeRes.recordset.map(p => ({ status: p.STATUS, count: p.count, updated_at: now }))
  );
  if (plErr) throw new Error(`insert wms_pipeline: ${plErr.message}`);
  console.log(`  ✓ wms_pipeline — ${pipeRes.recordset.length} statuser`);

  const activeRes = await pool.request().query(`
    SELECT
      pl.ID                AS picklist_id,
      pl.STATUS,
      pl.CREATED_TIME,
      pl.MODIFIED_TIME,
      pl.SHORTAGE,
      u.NAME               AS operator_name,
      u.USERNAME           AS operator_username,
      u.ID                 AS operator_id,
      COUNT(pll.ID)        AS total_lines,
      SUM(CASE WHEN pll.STATUS  = 'FINISHED' THEN 1 ELSE 0 END) AS finished_lines,
      SUM(CASE WHEN pll.SHORTAGE = 1         THEN 1 ELSE 0 END) AS shortage_lines,
      MIN(pll.ORDER_ID)    AS order_ref,
      pl.ZONES             AS zones
    FROM wms_picklist pl
    LEFT JOIN auth_user u         ON u.ID = pl.ASSIGNED_TO
    LEFT JOIN wms_picklist_line pll ON pll.PICKLIST_ID = pl.ID
    WHERE pl.STATUS IN ('OPEN','STARTED')
      AND pl.CREATED_TIME >= DATEADD(DAY, -7, GETDATE())
    GROUP BY pl.ID, pl.STATUS, pl.CREATED_TIME, pl.MODIFIED_TIME,
             pl.SHORTAGE, u.NAME, u.USERNAME, u.ID, pl.ZONES
    ORDER BY pl.CREATED_TIME DESC
  `);

  const activeRows = activeRes.recordset.map(o => ({
    picklist_id:       o.picklist_id,
    status:            o.STATUS,
    created_time:      o.CREATED_TIME,
    modified_time:     o.MODIFIED_TIME,
    shortage:          o.SHORTAGE,
    operator_name:     o.operator_name,
    operator_username: o.operator_username,
    operator_id:       o.operator_id,
    total_lines:       o.total_lines,
    finished_lines:    o.finished_lines,
    shortage_lines:    o.shortage_lines,
    order_ref:         o.order_ref != null ? String(o.order_ref) : null,
    zones:             o.zones,
    updated_at:        now,
  }));

  await upsert('wms_active_picklists', activeRows, 'picklist_id');
  await deleteStale('wms_active_picklists', 'picklist_id', activeRows.map(r => r.picklist_id));

  // ── 6. Operators today ─────────────────────────────────
  const opRes = await pool.request()
    .input('date', sql.VarChar, today)
    .query(`
      SELECT
        u.ID       AS operator_id,
        u.NAME     AS operator_name,
        u.USERNAME,
        COUNT(CASE
          WHEN t.LOCATION_FROM_ID IS NOT NULL
           AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
           AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
          THEN t.ID END) AS pick_count,
        COUNT(CASE WHEN t.LOCATION_ID = 'MOTTAK'  THEN t.ID END) AS receive_count,
        COUNT(CASE WHEN t.LOCATION_ID = 'Bermuda' THEN t.ID END) AS return_count,
        COUNT(CASE
          WHEN t.LOCATION_FROM_ID IS NOT NULL
           AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
           AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
          THEN t.ID END) AS move_count,
        COUNT(t.ID) AS total_transactions
      FROM auth_user u
      JOIN wms_transaction t ON t.PERFORMED_BY = u.ID ${wh('t')}
      WHERE t.STATUS = 'CLOSED'
        AND CAST(t.CREATED_TIME AS DATE) = @date
      GROUP BY u.ID, u.NAME, u.USERNAME
      HAVING COUNT(t.ID) > 0
      ORDER BY total_transactions DESC
    `);

  const opRows = opRes.recordset.map(op => {
    const total = op.total_transactions || 1;
    return {
      operator_id:        op.operator_id,
      operator_name:      op.operator_name,
      username:           op.USERNAME,
      pick_count:         op.pick_count,
      receive_count:      op.receive_count,
      return_count:       op.return_count,
      move_count:         op.move_count,
      total_transactions: op.total_transactions,
      pick_pct:    Math.round((op.pick_count    / total) * 100),
      receive_pct: Math.round((op.receive_count / total) * 100),
      return_pct:  Math.round((op.return_count  / total) * 100),
      move_pct:    Math.round((op.move_count    / total) * 100),
      updated_at:  now,
    };
  });

  await upsert('wms_operators_today', opRows, 'operator_id');
  await deleteStale('wms_operators_today', 'operator_id', opRows.map(r => r.operator_id));

  // ── 7. Mottak today ────────────────────────────────────
  const mottakRes = await pool.request()
    .input('days', sql.Int, 1)
    .query(`
      SELECT
        t.ID, t.CREATED_TIME, t.QUANTITY,
        t.LOCATION_ID, t.LOCATION_FROM_ID,
        p.NAME       AS product_name,
        p.PRODUCT_NO AS sku,
        u.NAME       AS operator_name
      FROM wms_transaction t
      JOIN wms_product p    ON p.ID = t.PRODUCT_ID
      LEFT JOIN auth_user u ON u.ID = t.PERFORMED_BY
      WHERE t.LOCATION_ID = 'MOTTAK'
        AND t.STATUS = 'CLOSED'
        AND t.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
        ${wh('t')}
      ORDER BY t.CREATED_TIME DESC
    `);

  await upsert('wms_mottak_today', mottakRes.recordset.map(t => ({
    id:               t.ID,
    created_time:     t.CREATED_TIME,
    quantity:         t.QUANTITY,
    location_id:      t.LOCATION_ID,
    location_from_id: t.LOCATION_FROM_ID,
    product_name:     t.product_name,
    sku:              t.sku,
    operator_name:    t.operator_name,
    updated_at:       now,
  })));

  // Clean up mottak older than 2 days
  const mottakCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('wms_mottak_today').delete().lt('created_time', mottakCutoff);

  // ── 8. Activity feed (last 24h) ────────────────────────
  const histRes = await pool.request()
    .input('hours', sql.Int, 24)
    .query(`
      SELECT TOP 50
        t.ID, t.CREATED_TIME, t.QUANTITY,
        t.LOCATION_ID, t.LOCATION_FROM_ID, t.STATUS,
        p.NAME       AS product_name,
        p.PRODUCT_NO AS sku,
        u.NAME       AS operator_name,
        l.ZONE_ID    AS zone_id,
        z.NAME       AS zone_name,
        CASE
          WHEN t.LOCATION_ID = 'MOTTAK'  THEN 'MOTTAK'
          WHEN t.LOCATION_ID = 'Bermuda' THEN 'RETUR'
          WHEN t.LOCATION_FROM_ID IS NOT NULL
           AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
           AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL}) THEN 'PLUKK'
          WHEN t.LOCATION_FROM_ID IS NOT NULL
           AND t.LOCATION_FROM_ID IN (${SYS_LOCS_SQL})
           AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL}) THEN 'VAREPÅFYLL'
          ELSE 'ANNET'
        END AS transaction_type
      FROM wms_transaction t
      JOIN wms_product p    ON p.ID = t.PRODUCT_ID
      LEFT JOIN auth_user u ON u.ID = t.PERFORMED_BY
      LEFT JOIN wms_location l ON l.LOCATION_ID = t.LOCATION_ID
      LEFT JOIN wms_zone z     ON z.ZONE_ID = l.ZONE_ID
      WHERE t.STATUS = 'CLOSED'
        AND t.CREATED_TIME >= DATEADD(HOUR, -@hours, GETDATE())
        ${wh('t')}
      ORDER BY t.CREATED_TIME DESC
    `);

  const actSeen = new Set();
  await upsert('wms_activity_feed', histRes.recordset
    .filter(h => { if (actSeen.has(h.ID)) return false; actSeen.add(h.ID); return true; })
    .map(h => ({
    id:               h.ID,
    created_time:     h.CREATED_TIME,
    quantity:         h.QUANTITY,
    location_id:      h.LOCATION_ID,
    location_from_id: h.LOCATION_FROM_ID,
    status:           h.STATUS,
    product_name:     h.product_name,
    sku:              h.sku,
    operator_name:    h.operator_name,
    zone_id:          h.zone_id,
    zone_name:        h.zone_name,
    transaction_type: h.transaction_type,
    updated_at:       now,
  })));

  // Clean up activity older than 26 hours
  const actCutoff = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
  await supabase.from('wms_activity_feed').delete().lt('created_time', actCutoff);

  // ── Log sync result ────────────────────────────────────
  const durationMs = Date.now() - startMs;
  await supabase.from('wms_sync_log').insert({
    synced_at:   now,
    status:      'ok',
    duration_ms: durationMs,
  });

  await pool.close();
  console.log(`\n✅  Sync ferdig på ${durationMs}ms`);
}

// ── Entry point ─────────────────────────────────────────
syncAll().catch(async (err) => {
  console.error('\n❌  Sync feilet:', err.message);
  try {
    await supabase.from('wms_sync_log').insert({
      synced_at:   new Date().toISOString(),
      status:      'error',
      error:       err.message,
      duration_ms: 0,
    });
  } catch (_) { /* ignore secondary failure */ }
  process.exit(1);
});
