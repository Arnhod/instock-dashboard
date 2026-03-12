// src/routes/zones.js
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const cfg = require('../customer.config');

// ── SQL-fragmenter bygd fra config (én gang ved modulinnlasting) ──
const ALL_ZONE_IDS = cfg.zones.map(z => `'${z.id}'`).join(',');
const HOT_ZONE_IDS = cfg.zones.filter(z => z.hot).map(z => `'${z.id}'`).join(',');
const COLD_IDS_SQL = cfg.coldStatusIds.join(',');
const SYS_LOCS_SQL = cfg.systemLocations.map(l => `'${l}'`).join(',');

// Valgfritt warehouse-filter (tom streng hvis warehouse.id er null)
const wh = (alias) =>
  cfg.warehouse.id ? `AND ${alias}.WAREHOUSE_ID = ${Number(cfg.warehouse.id)}` : '';

// ─────────────────────────────────────────────
// GET /api/zones?days=7
// Plukk-telling og utnyttelse per sone
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('days', sql.Int, days)
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
          ON l.ZONE_ID = z.ZONE_ID
          AND l.ACTIVE = 1
          ${wh('l')}
        LEFT JOIN wms_stock s
          ON s.LOCATION_ID = l.LOCATION_ID
          AND s.WAREHOUSE_ID = l.WAREHOUSE_ID
        LEFT JOIN (
          SELECT
            loc.ZONE_ID,
            COUNT(tr.ID)                  AS pick_count,
            COUNT(DISTINCT tr.PRODUCT_ID) AS unique_products
          FROM wms_transaction tr
          JOIN wms_location loc
            ON loc.LOCATION_ID = tr.LOCATION_FROM_ID
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

    res.json({ days, zones: result.recordset });
  } catch (err) {
    console.error('zones error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/zones/hotzone?days=7&limit=20
// Topp-N varer sortert på plukk-frekvens
// ─────────────────────────────────────────────
router.get('/hotzone', async (req, res) => {
  const days  = parseInt(req.query.days)  || 7;
  const limit = parseInt(req.query.limit) || 20;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('days',  sql.Int, days)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit)
          p.ID                              AS product_id,
          p.PRODUCT_NO                      AS sku,
          p.NAME                            AS product_name,
          p.QTY_IN_STOCK                    AS qty_in_stock,
          ps.NAME                           AS status_name,
          ps.ID                             AS status_id,
          l.LOCATION_ID                     AS current_location,
          l.ZONE_ID                         AS current_zone_id,
          z.NAME                            AS current_zone_name,
          COUNT(t.ID)                       AS pick_count,
          CASE WHEN l.ZONE_ID IN (${HOT_ZONE_IDS}) THEN 1 ELSE 0 END AS in_hot_zone,
          CASE WHEN l.ZONE_ID NOT IN (${HOT_ZONE_IDS}) THEN 1 ELSE 0 END AS misplaced
        FROM wms_transaction t
        JOIN wms_product p
          ON p.ID = t.PRODUCT_ID
        JOIN wms_location l
          ON l.LOCATION_ID = t.LOCATION_FROM_ID
        LEFT JOIN wms_zone z
          ON z.ZONE_ID = l.ZONE_ID
        LEFT JOIN wms_product_status ps
          ON ps.ID = p.STATUS_CODE_ID
        WHERE t.STATUS = 'CLOSED'
          AND t.LOCATION_FROM_ID IS NOT NULL
          AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
          AND t.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
          ${wh('t')}
        GROUP BY
          p.ID, p.PRODUCT_NO, p.NAME, p.QTY_IN_STOCK,
          ps.NAME, ps.ID,
          l.LOCATION_ID, l.ZONE_ID, z.NAME
        ORDER BY pick_count DESC
      `);

    res.json({ days, limit, items: result.recordset });
  } catch (err) {
    console.error('hotzone error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/zones/move-suggest
// Varer med "kalde" statuser som ligger i hot zone
// ─────────────────────────────────────────────
router.get('/move-suggest', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query(`
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
        JOIN wms_product p
          ON p.ID = s.PRODUCT_ID
        JOIN wms_product_status ps
          ON ps.ID = p.STATUS_CODE_ID
        JOIN wms_location l
          ON l.LOCATION_ID = s.LOCATION_ID
          ${wh('l')}
        LEFT JOIN wms_zone z
          ON z.ZONE_ID = l.ZONE_ID
        WHERE ps.ID IN (${COLD_IDS_SQL})
          AND l.ZONE_ID IN (${HOT_ZONE_IDS})
          AND s.QUANTITY > 0
        ORDER BY ps.ID, s.QUANTITY DESC
      `);

    res.json({ move_candidates: result.recordset });
  } catch (err) {
    console.error('move-suggest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/zones/stock?zone=ZONE_A&limit=50
// ─────────────────────────────────────────────
router.get('/stock', async (req, res) => {
  const zone  = req.query.zone  || null;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const pool    = await getPool();
    const request = pool.request().input('limit', sql.Int, limit);
    let zoneFilter = '';
    if (zone) {
      request.input('zone', sql.VarChar, zone);
      zoneFilter = 'AND l.ZONE_ID = @zone';
    }

    const result = await request.query(`
      SELECT TOP (@limit)
        s.LOCATION_ID,
        l.NAME            AS location_name,
        l.ZONE_ID,
        z.NAME            AS zone_name,
        p.PRODUCT_NO      AS sku,
        p.NAME            AS product_name,
        ps.NAME           AS status_name,
        s.QUANTITY,
        s.QTY_PENDING,
        s.RECEIVED_DATE
      FROM wms_stock s
      JOIN wms_product p
        ON p.ID = s.PRODUCT_ID
      JOIN wms_location l
        ON l.LOCATION_ID = s.LOCATION_ID
        ${wh('l')}
      LEFT JOIN wms_zone z
        ON z.ZONE_ID = l.ZONE_ID
      LEFT JOIN wms_product_status ps
        ON ps.ID = p.STATUS_CODE_ID
      WHERE s.QUANTITY > 0
        AND l.ACTIVE = 1
        ${zoneFilter}
      ORDER BY z.SORT, s.LOCATION_ID, p.NAME
    `);

    res.json({ stock: result.recordset });
  } catch (err) {
    console.error('stock error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
