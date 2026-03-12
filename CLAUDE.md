# CLAUDE.md — Instock WMS Dashboard

This file gives Claude full context about the project.
Read this before making changes.

---

## Project overview

A reusable warehouse dashboard for the Instock WMS platform (Azure SQL).
Displays live warehouse activity on large screens around the warehouse.

**Production architecture:**
```
Azure SQL (Instock)  →  sync/index.js (GitHub Actions cron)  →  Supabase  →  dashboard/index.html (Vercel)
```

**Local dev architecture:**
```
Azure SQL (Instock)  →  wms-api/ (Express, port 3001)  →  wms-dashboard-v2.html
```

**Stack:**
- Sync job: Node.js, mssql, @supabase/supabase-js
- Local API: Node.js, Express, mssql
- Database: Azure SQL (Instock WMS)
- Cache layer: Supabase (PostgreSQL)
- Dashboard: Vanilla HTML/CSS/JS
- Font: Plus Jakarta Sans (Google Fonts)
- Hosting: Vercel (static) + GitHub Actions (cron)

---

## Project structure

```
/
├── .github/workflows/
│   └── sync.yml              ← Cron job every 30 min: Azure SQL → Supabase
│
├── dashboard/
│   ├── index.html            ← Production dashboard (reads from Supabase)
│   ├── config.js             ← GITIGNORED — Supabase URL + anon key
│   └── config.example.js     ← Template for config.js
│
├── wms-api/            ← Local dev only (not deployed to cloud)
│   ├── .env                  ← GITIGNORED — DB credentials
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── src/
│   │   ├── db.js             ← Azure SQL connection pool (mssql)
│   │   ├── server.js         ← Express app, routes, /api/config, static serving
│   │   ├── customer.config.js       ← GITIGNORED — customer-specific settings
│   │   ├── customer.config.example.js
│   │   └── routes/
│   │       ├── zones.js      ← /api/zones, /api/zones/hotzone, /api/zones/move-suggest, /api/zones/stock
│   │       ├── orders.js     ← /api/orders, /api/orders/picklist/:id
│   │       ├── operators.js  ← /api/operators, /api/operators/:id
│   │       └── inbound.js    ← /api/inbound, /api/inbound/mottak, /api/inbound/flow, /api/inbound/history
│   └── wms-dashboard-v2.html ← Local dev dashboard (fetches from Express API)
│
├── supabase/
│   └── schema.sql            ← Run once in Supabase SQL Editor
│
├── sync/
│   ├── index.js              ← Main sync script: reads Azure SQL, writes Supabase
│   ├── package.json          ← Dependencies: mssql, @supabase/supabase-js, dotenv
│   ├── package-lock.json
│   └── .env.example          ← Template (sync/.env is gitignored)
│
├── .gitignore
├── vercel.json               ← outputDirectory: "dashboard"
└── README.md
```

---

## Customer config

All customer-specific settings live in ONE place per deployment mode:

**Local dev:** `wms-api/src/customer.config.js` (gitignored, copy from .example.js)
**Production (sync):** GitHub Actions Secrets (see sync/.env.example for all keys)

Customer config contains:
- `CUSTOMER_NAME`, `CUSTOMER_SHORT`, `CUSTOMER_COLOR` — branding
- `WAREHOUSE_ID` — null = all warehouses, number = filter by ID
- `ZONES_JSON` — array of `{ id, name, color, hot }` objects
- `COLD_STATUS_IDS` — product status IDs to flag for hot zone removal
- `SYSTEM_LOCATIONS` — non-physical locations to exclude from pick analysis

---

## Database — Instock Azure SQL

```
Server:  your-server.database.windows.net,3342
Auth:    SQL Server Authentication
User:    your-db-user
Encrypt: true, TrustServerCertificate: true
```

DB name is in `.env` as `DB_NAME`.

### Key tables

**wms_transaction** — all warehouse movements
```
ID, SESSION_ID, LOCATION_ID, LOCATION_FROM_ID,
WAREHOUSE_ID, PRODUCT_ID, QUANTITY,
PERFORMED_BY (→ auth_user.ID),
CREATED_TIME, STATUS ('CLOSED'|'OPEN'),
CAUSECODE_ID (always NULL in prod — do not use)
```

**wms_location** — all shelf locations
```
LOCATION_ID (varchar PK, e.g. 'A-03-021-06'),
ZONE_ID (→ wms_zone.ZONE_ID),
WAREHOUSE_ID, NAME, ACTIVE (bit), QTY_IN_STOCK, PICK_TYPE
```
Location format: `[Row]-[RowNo]-[Shelf]-[Height]`

**wms_zone** — `ZONE_ID (PK), NAME, WAREHOUSE_ID, SORT`

**wms_product** — `ID, PRODUCT_NO (SKU), NAME, STATUS_CODE_ID, QTY_IN_STOCK, DEFAULT_LOCATION, DELETED`

**wms_product_status** — `ID, NAME`
| ID | NAME | Dashboard action |
|----|------|-----------------|
| 1 | AKTIV | Normal |
| 2 | EOL | Move out of hot zone |
| 6 | SESONGVARE | Move out of hot zone |
| 9 | DEAKTIVERT | Move out of hot zone |
| 12 | OUTLET | Move out of hot zone |

**wms_stock** — `LOCATION_ID, PRODUCT_ID, WAREHOUSE_ID, QUANTITY, QTY_PENDING, RECEIVED_DATE`

**wms_picklist** — `ID, STATUS ('OPEN'|'STARTED'|'FINISHED'|'CANCELLED'), ASSIGNED_TO, CREATED_TIME, ZONES`

**wms_picklist_line** — `ID, PICKLIST_ID, ORDER_ID, PRODUCT_ID, LOCATION_ID, QTY_ORDERED, QTY_PICKED, STATUS, SHORTAGE`

**auth_user** — `ID, USERNAME, NAME, EMAIL, ENABLED, DEPARTMENT`

---

## Transaction logic

`CAUSECODE_ID` is always NULL in production. Transaction type is determined by `LOCATION_ID` / `LOCATION_FROM_ID`:

| Type | Rule |
|------|------|
| **Pick** | `LOCATION_FROM_ID` = shelf (not system location) |
| **Receive** | `LOCATION_ID = 'MOTTAK'` |
| **Return** | `LOCATION_ID = 'Bermuda'` |
| **Zone move** | Both = shelf, different ZONE_ID |

System locations (not physical shelves) — used to exclude non-pick transactions:
```
'MOTTAK', 'Bermuda', 'REKLAMASJON', 'EOL'
// + add any customer-specific system locations
```

---

## Supabase tables

All written by `sync/index.js`, read by `dashboard/index.html` via anon key.

| Table | Description |
|-------|-------------|
| `wms_config` | Customer branding + zone definitions (single row) |
| `wms_zone_stats` | Pick activity per zone (7 days) |
| `wms_hotzone_items` | Top 20 products by pick frequency |
| `wms_move_candidates` | Cold-status products in hot zone |
| `wms_pipeline` | Picklist pipeline counts |
| `wms_active_picklists` | Active picklists (OPEN + STARTED) |
| `wms_operators_today` | Operator activity today |
| `wms_mottak_today` | Goods received today |
| `wms_activity_feed` | Recent transactions (24h) |
| `wms_sync_log` | Sync job history |

---

## API endpoints (local dev only — wms-api)

```
GET /api/config
GET /api/health
GET /api/zones                   ?days=7
GET /api/zones/hotzone           ?days=7&limit=20
GET /api/zones/move-suggest
GET /api/zones/stock             ?zone=ZONE_A&limit=50
GET /api/orders                  ?status=OPEN
GET /api/orders/picklist/:id
GET /api/operators               ?date=2026-03-12
GET /api/operators/:id           ?days=7
GET /api/inbound
GET /api/inbound/mottak          ?days=1
GET /api/inbound/flow            ?hours=24
GET /api/inbound/history         ?hours=24
```

---

## Code style

- async/await everywhere, no promise chains
- const over let
- Small, focused functions
- Comment SQL queries with explanation
- Error handling: always try/catch with console.error + res.status(500)
- No new npm packages without good reason

---

## TODO

- [ ] `wms_purchase_arrival` column structure not fully mapped — inbound.js fetches columns dynamically
- [ ] API authentication missing (JWT or API key) for wms-api
- [ ] WebSocket instead of polling for near-real-time dashboard updates
- [ ] WAREHOUSE_ID filter not applied to all queries yet
