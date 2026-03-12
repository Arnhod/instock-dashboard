// src/routes/operators.js
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const cfg = require('../customer.config');

const SYS_LOCS_SQL = cfg.systemLocations.map(l => `'${l}'`).join(',');
const wh = (alias) =>
  cfg.warehouse.id ? `AND ${alias}.WAREHOUSE_ID = ${Number(cfg.warehouse.id)}` : '';

// ─────────────────────────────────────────────
// GET /api/operators?date=2026-03-12
// Alle operatører med transaksjonstelling i dag
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('date', sql.VarChar, date)
      .query(`
        SELECT
          u.ID                AS operator_id,
          u.NAME              AS operator_name,
          u.USERNAME,

          COUNT(CASE
            WHEN t.LOCATION_FROM_ID IS NOT NULL
             AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
             AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
            THEN t.ID END
          ) AS pick_count,

          COUNT(CASE
            WHEN t.LOCATION_ID = 'MOTTAK'
            THEN t.ID END
          ) AS receive_count,

          COUNT(CASE
            WHEN t.LOCATION_ID = 'Bermuda'
            THEN t.ID END
          ) AS return_count,

          COUNT(CASE
            WHEN t.LOCATION_FROM_ID IS NOT NULL
             AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
             AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
            THEN t.ID END
          ) AS move_count,

          COUNT(t.ID) AS total_transactions

        FROM auth_user u
        JOIN wms_transaction t
          ON t.PERFORMED_BY = u.ID
          ${wh('t')}
        WHERE t.STATUS = 'CLOSED'
          AND CAST(t.CREATED_TIME AS DATE) = @date
        GROUP BY u.ID, u.NAME, u.USERNAME
        HAVING COUNT(t.ID) > 0
        ORDER BY total_transactions DESC
      `);

    const operators = result.recordset.map(op => {
      const total = op.total_transactions || 1;
      return {
        ...op,
        pick_pct:    Math.round((op.pick_count    / total) * 100),
        receive_pct: Math.round((op.receive_count / total) * 100),
        return_pct:  Math.round((op.return_count  / total) * 100),
        move_pct:    Math.round((op.move_count    / total) * 100),
      };
    });

    res.json({ date, operators });
  } catch (err) {
    console.error('operators error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/operators/:id?days=7
// Én operatør — historisk breakdown per dag
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const operatorId = parseInt(req.params.id);
  const days = parseInt(req.query.days) || 7;
  try {
    const pool = await getPool();

    const userResult = await pool.request()
      .input('id', sql.Int, operatorId)
      .query(`SELECT ID, NAME, USERNAME, EMAIL FROM auth_user WHERE ID = @id`);

    if (!userResult.recordset.length) {
      return res.status(404).json({ error: 'Operatør ikke funnet' });
    }

    const txResult = await pool.request()
      .input('id',   sql.Int, operatorId)
      .input('days', sql.Int, days)
      .query(`
        SELECT
          CAST(t.CREATED_TIME AS DATE) AS dato,

          COUNT(CASE
            WHEN t.LOCATION_FROM_ID IS NOT NULL
             AND t.LOCATION_FROM_ID NOT IN (${SYS_LOCS_SQL})
             AND t.LOCATION_ID     NOT IN (${SYS_LOCS_SQL})
            THEN t.ID END
          ) AS pick_count,

          COUNT(CASE WHEN t.LOCATION_ID = 'MOTTAK'  THEN t.ID END) AS receive_count,
          COUNT(CASE WHEN t.LOCATION_ID = 'Bermuda' THEN t.ID END) AS return_count,
          COUNT(t.ID) AS total

        FROM wms_transaction t
        WHERE t.PERFORMED_BY = @id
          AND t.STATUS = 'CLOSED'
          AND t.CREATED_TIME >= DATEADD(DAY, -@days, GETDATE())
          ${wh('t')}
        GROUP BY CAST(t.CREATED_TIME AS DATE)
        ORDER BY dato DESC
      `);

    res.json({
      operator: userResult.recordset[0],
      history:  txResult.recordset,
    });
  } catch (err) {
    console.error('operator detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
