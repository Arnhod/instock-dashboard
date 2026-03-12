// src/routes/inbound.js
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const cfg = require('../customer.config');

const SYS_LOCS_SQL = cfg.systemLocations.map(l => `'${l}'`).join(',');
const wh = (alias) =>
  cfg.warehouse.id ? `AND ${alias}.WAREHOUSE_ID = ${Number(cfg.warehouse.id)}` : '';

// ─────────────────────────────────────────────
// GET /api/inbound
// Innkommende leveranser fra wms_purchase_arrival
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();

    const cols = await pool.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'wms_purchase_arrival'
      ORDER BY ORDINAL_POSITION
    `);

    const result = await pool.request().query(`
      SELECT TOP 50 *
      FROM wms_purchase_arrival
      ORDER BY CREATED_TIME DESC
    `);

    res.json({
      columns:  cols.recordset.map(c => c.COLUMN_NAME),
      arrivals: result.recordset,
    });
  } catch (err) {
    console.error('inbound error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/inbound/mottak?days=1
// Varer registrert på MOTTAK siste X dager
// ─────────────────────────────────────────────
router.get('/mottak', async (req, res) => {
  const days = parseInt(req.query.days) || 1;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('days', sql.Int, days)
      .query(`
        SELECT
          t.ID,
          t.CREATED_TIME,
          t.QUANTITY,
          t.LOCATION_ID,
          t.LOCATION_FROM_ID,
          p.NAME        AS product_name,
          p.PRODUCT_NO  AS sku,
          u.NAME        AS operator_name
        FROM wms_transaction t
        JOIN wms_product p
          ON p.ID = t.PRODUCT_ID
        LEFT JOIN auth_user u
          ON u.ID = t.PERFORMED_BY
        WHERE t.LOCATION_ID = 'MOTTAK'
          AND t.STATUS = 'CLOSED'
          AND t.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
          ${wh('t')}
        ORDER BY t.CREATED_TIME DESC
      `);

    res.json({ days, transactions: result.recordset });
  } catch (err) {
    console.error('mottak error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/inbound/flow?hours=24
// Intern soneflytt siste X timer
// ─────────────────────────────────────────────
router.get('/flow', async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('hours', sql.Int, hours)
      .query(`
        SELECT TOP 100
          t.ID,
          t.CREATED_TIME,
          t.QUANTITY,
          t.LOCATION_FROM_ID,
          t.LOCATION_ID         AS location_to,
          lf.ZONE_ID            AS zone_from,
          zf.NAME               AS zone_from_name,
          lt.ZONE_ID            AS zone_to,
          zt.NAME               AS zone_to_name,
          p.NAME                AS product_name,
          p.PRODUCT_NO          AS sku,
          u.NAME                AS operator_name
        FROM wms_transaction t
        JOIN wms_product p
          ON p.ID = t.PRODUCT_ID
        JOIN wms_location lf
          ON lf.LOCATION_ID = t.LOCATION_FROM_ID
        JOIN wms_location lt
          ON lt.LOCATION_ID = t.LOCATION_ID
        LEFT JOIN wms_zone zf ON zf.ZONE_ID = lf.ZONE_ID
        LEFT JOIN wms_zone zt ON zt.ZONE_ID = lt.ZONE_ID
        LEFT JOIN auth_user u
          ON u.ID = t.PERFORMED_BY
        WHERE t.STATUS = 'CLOSED'
          AND t.LOCATION_FROM_ID IS NOT NULL
          AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
          AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
          AND lf.ZONE_ID != lt.ZONE_ID
          AND t.CREATED_TIME >= DATEADD(HOUR, -@hours, GETDATE())
          ${wh('t')}
        ORDER BY t.CREATED_TIME DESC
      `);

    res.json({ hours, flow: result.recordset });
  } catch (err) {
    console.error('flow error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/inbound/history?hours=24
// Transaksjonshistorikk for timeline-visning
// ─────────────────────────────────────────────
router.get('/history', async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('hours', sql.Int, hours)
      .query(`
        SELECT TOP 50
          t.ID,
          t.CREATED_TIME,
          t.QUANTITY,
          t.LOCATION_ID,
          t.LOCATION_FROM_ID,
          t.STATUS,
          p.NAME        AS product_name,
          p.PRODUCT_NO  AS sku,
          u.NAME        AS operator_name,
          l.ZONE_ID     AS zone_id,
          z.NAME        AS zone_name,
          CASE
            WHEN t.LOCATION_ID = 'MOTTAK'  THEN 'MOTTAK'
            WHEN t.LOCATION_ID = 'Bermuda' THEN 'RETUR'
            WHEN t.LOCATION_FROM_ID IS NOT NULL
             AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL}) THEN 'PLUKK'
            ELSE 'ANNET'
          END AS transaction_type
        FROM wms_transaction t
        JOIN wms_product p ON p.ID = t.PRODUCT_ID
        LEFT JOIN auth_user u ON u.ID = t.PERFORMED_BY
        LEFT JOIN wms_location l ON l.LOCATION_ID = t.LOCATION_ID
        LEFT JOIN wms_zone z ON z.ZONE_ID = l.ZONE_ID
        WHERE t.STATUS = 'CLOSED'
          AND t.CREATED_TIME >= DATEADD(HOUR, -@hours, GETDATE())
          ${wh('t')}
        ORDER BY t.CREATED_TIME DESC
      `);

    res.json({ hours, history: result.recordset });
  } catch (err) {
    console.error('history error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
