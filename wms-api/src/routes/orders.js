// src/routes/orders.js
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const cfg = require('../customer.config');

const wh = (alias) =>
  cfg.warehouse.id ? `AND ${alias}.WAREHOUSE_ID = ${Number(cfg.warehouse.id)}` : '';

// ─────────────────────────────────────────────
// GET /api/orders?status=OPEN
// Ordrer med status og operatørnavn
// Picklist statuser i Instock: OPEN, STARTED, FINISHED, CANCELLED
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const status = req.query.status || null;
  try {
    const pool = await getPool();
    const request = pool.request();
    let statusFilter = '';
    if (status) {
      request.input('status', sql.VarChar, status);
      statusFilter = "AND pl.STATUS = @status";
    } else {
      statusFilter = "AND pl.STATUS IN ('OPEN','STARTED')";
    }

    const result = await request.query(`
      SELECT
        pl.ID                         AS picklist_id,
        pl.STATUS,
        pl.CREATED_TIME,
        pl.MODIFIED_TIME,
        pl.SHORTAGE,
        u.NAME                        AS operator_name,
        u.USERNAME                    AS operator_username,
        u.ID                          AS operator_id,
        COUNT(pll.ID)                 AS total_lines,
        SUM(CASE WHEN pll.STATUS = 'FINISHED' THEN 1 ELSE 0 END) AS finished_lines,
        SUM(CASE WHEN pll.SHORTAGE = 1 THEN 1 ELSE 0 END)        AS shortage_lines,
        -- Første ordrenummer på denne plukklisten
        MIN(pll.ORDER_ID)             AS order_ref,
        -- Soner involvert
        pl.ZONES                      AS zones
      FROM wms_picklist pl
      LEFT JOIN auth_user u
        ON u.ID = pl.ASSIGNED_TO
      LEFT JOIN wms_picklist_line pll
        ON pll.PICKLIST_ID = pl.ID
      WHERE pl.CREATED_TIME >= DATEADD(DAY, -1, GETDATE())
        ${statusFilter}
      GROUP BY
        pl.ID, pl.STATUS, pl.CREATED_TIME, pl.MODIFIED_TIME,
        pl.SHORTAGE, u.NAME, u.USERNAME, u.ID, pl.ZONES
      ORDER BY pl.CREATED_TIME DESC
    `);

    // Pipeline-telling
    const pipeline = await pool.request().query(`
      SELECT
        STATUS,
        COUNT(*) AS count
      FROM wms_picklist
      WHERE CREATED_TIME >= DATEADD(DAY, -1, GETDATE())
        AND STATUS IN ('OPEN','STARTED','FINISHED')
      GROUP BY STATUS
    `);

    res.json({
      pipeline: pipeline.recordset,
      orders: result.recordset
    });
  } catch (err) {
    console.error('orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/orders/picklist/:operatorId
// Aktive plukklister for én operatør med linjedetaljer
// ─────────────────────────────────────────────
router.get('/picklist/:operatorId', async (req, res) => {
  const operatorId = parseInt(req.params.operatorId);
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('operatorId', sql.Int, operatorId)
      .query(`
        SELECT
          pl.ID                   AS picklist_id,
          pl.STATUS               AS picklist_status,
          pll.ID                  AS line_id,
          pll.ORDER_ID,
          pll.DESCRIPTION,
          pll.LOCATION_ID,
          pll.QTY_ORDERED,
          pll.QTY_PICKED,
          pll.STATUS              AS line_status,
          pll.SHORTAGE,
          p.NAME                  AS product_name,
          p.PRODUCT_NO            AS sku,
          l.ZONE_ID,
          z.NAME                  AS zone_name
        FROM wms_picklist pl
        JOIN wms_picklist_line pll
          ON pll.PICKLIST_ID = pl.ID
        JOIN wms_product p
          ON p.ID = pll.PRODUCT_ID
        JOIN wms_location l
          ON l.LOCATION_ID = pll.LOCATION_ID
        LEFT JOIN wms_zone z
          ON z.ZONE_ID = l.ZONE_ID
        WHERE pl.ASSIGNED_TO = @operatorId
          AND pl.STATUS IN ('OPEN','STARTED')
        ORDER BY pl.ID DESC, pll.POS_NO
      `);

    res.json({ lines: result.recordset });
  } catch (err) {
    console.error('picklist error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
