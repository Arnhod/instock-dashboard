// src/server.js — Instock WMS Dashboard API
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const cfg     = require('./customer.config');

const zonesRouter    = require('./routes/zones');
const ordersRouter   = require('./routes/orders');
const operatorsRouter = require('./routes/operators');
const inboundRouter  = require('./routes/inbound');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──
app.use(express.json());
app.use(cors({
  origin: [
    process.env.DASHBOARD_URL || 'http://localhost:3001',
    'http://localhost:5500',   // Live Server (VS Code)
    'null',                    // file:// åpning lokalt
  ],
  methods: ['GET'],
}));

// ── Dashboard (statiske filer) ──
const PUBLIC_DIR = path.join(__dirname, '..');
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wms-dashboard-v2.html')));

// ── Routes ──
app.use('/api/zones',     zonesRouter);
app.use('/api/orders',    ordersRouter);
app.use('/api/operators', operatorsRouter);
app.use('/api/inbound',   inboundRouter);

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ── Customer config (ikke-sensitiv — kun det dashboard trenger) ──
app.get('/api/config', (req, res) => {
  res.json({
    customer:    cfg.customer,
    zones:       cfg.zones,
    hotZoneIds:  cfg.zones.filter(z => z.hot).map(z => z.id),
    coldStatusIds: cfg.coldStatusIds,
  });
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: `Endepunkt ikke funnet: ${req.path}` });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n🚀 Instock WMS Dashboard API kjører på http://localhost:${PORT}`);
  console.log(`   Endepunkter:`);
  console.log(`   GET /api/health`);
  console.log(`   GET /api/zones`);
  console.log(`   GET /api/zones/hotzone`);
  console.log(`   GET /api/zones/move-suggest`);
  console.log(`   GET /api/zones/stock`);
  console.log(`   GET /api/orders`);
  console.log(`   GET /api/orders/picklist/:operatorId`);
  console.log(`   GET /api/operators`);
  console.log(`   GET /api/operators/:id`);
  console.log(`   GET /api/inbound`);
  console.log(`   GET /api/inbound/mottak`);
  console.log(`   GET /api/inbound/flow`);
  console.log(`   GET /api/inbound/history\n`);
});
