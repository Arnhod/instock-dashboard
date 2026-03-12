// reports/weekly-slotting.js — Weekly ABC Slotting Report
// Queries Supabase, generates HTML report, sends via Microsoft Graph API
// Run via GitHub Actions every Monday morning

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ── Config validation ─────────────────────────────────────
const required = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET',
  'REPORT_FROM_EMAIL', 'REPORT_TO_EMAIL',
];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Microsoft Graph API helpers ───────────────────────────

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.AZURE_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope:         'https://graph.microsoft.com/.default',
  });
  const res = await fetch(url, { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) throw new Error(`Graph token error: ${data.error_description}`);
  return data.access_token;
}

async function sendMail(token, subject, html) {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.REPORT_FROM_EMAIL)}/sendMail`;
  const toRecipients = process.env.REPORT_TO_EMAIL
    .split(';')
    .map(addr => addr.trim())
    .filter(Boolean)
    .map(addr => ({ emailAddress: { address: addr } }));
  const body = JSON.stringify({
    message: {
      subject,
      body:       { contentType: 'HTML', content: html },
      toRecipients,
    },
  });
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`sendMail failed (${res.status}): ${err}`);
  }
}

// ── Data fetching ─────────────────────────────────────────

async function fetchData() {
  const [configRes, zoneRes, hotzoneRes, candidatesRes] = await Promise.all([
    supabase.from('wms_config').select('*').single(),
    supabase.from('wms_zone_stats').select('*').order('pick_count', { ascending: false }),
    supabase.from('wms_hotzone_items').select('*').order('pick_count', { ascending: false }),
    supabase.from('wms_move_candidates').select('*').order('last_movement', { ascending: true }),
  ]);

  for (const { error } of [configRes, zoneRes, hotzoneRes, candidatesRes]) {
    if (error) throw new Error(`Supabase query error: ${error.message}`);
  }

  return {
    config:     configRes.data,
    zones:      zoneRes.data,
    hotzone:    hotzoneRes.data,
    candidates: candidatesRes.data,
  };
}

// ── ABC analysis ──────────────────────────────────────────

function buildAbcSummary(hotzone, hotZoneIds) {
  const aItems   = hotzone.filter(p => p.abc_class === 'A');
  const bItems   = hotzone.filter(p => p.abc_class === 'B');
  const cItems   = hotzone.filter(p => p.abc_class === 'C');

  const aInHot     = aItems.filter(p => hotZoneIds.includes(p.current_zone_id));
  const aMisplaced = aItems.filter(p => !hotZoneIds.includes(p.current_zone_id));

  return { aItems, bItems, cItems, aInHot, aMisplaced };
}

// ── HTML generation ───────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildHtml({ config, zones, hotzone, candidates }) {
  const hotZoneIds = config.hot_zone_ids || [];
  const primaryColor = config.primary_color || '#4f6ef7';
  const { aItems, bItems, cItems, aInHot, aMisplaced } = buildAbcSummary(hotzone, hotZoneIds);
  const weekStr = new Date().toLocaleDateString('nb-NO', { day: '2-digit', month: 'long', year: 'numeric' });

  // Zone stats rows
  const zoneRows = zones.map(z => {
    const isHot = hotZoneIds.includes(z.zone_id);
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${z.zone_name || z.zone_id}${isHot ? ' 🔥' : ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right">${z.pick_count?.toLocaleString('nb-NO') ?? '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right">${z.pick_count_today?.toLocaleString('nb-NO') ?? '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right">${z.products_in_zone?.toLocaleString('nb-NO') ?? '—'}</td>
      </tr>`;
  }).join('');

  // Misplaced A-items table (top 20)
  const misplacedRows = aMisplaced.slice(0, 20).map(p => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:13px">${p.sku}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.product_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.current_location || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.current_zone_name || p.current_zone_id || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right">${p.pick_count}</td>
      </tr>`).join('');

  // Move candidates table (top 20)
  const candidateRows = candidates.slice(0, 20).map(p => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:13px">${p.sku}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.product_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.status_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${p.current_location || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">${formatDate(p.last_movement)}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="nb">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0">
<tr><td>
<table width="620" cellpadding="0" cellspacing="0" align="center" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">

  <!-- Header -->
  <tr>
    <td style="background:${primaryColor};padding:28px 32px">
      <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:1px">${config.customer_name || 'Lager'}</p>
      <h1 style="margin:4px 0 0;font-size:22px;font-weight:700;color:#fff">Ukentlig slottingsrapport</h1>
      <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.8)">${weekStr}</p>
    </td>
  </tr>

  <!-- ABC Summary -->
  <tr>
    <td style="padding:24px 32px 8px">
      <h2 style="margin:0 0 16px;font-size:15px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">ABC-klassifisering (siste 7 dager)</h2>
      <table width="100%" cellpadding="0" cellspacing="8">
        <tr>
          <td width="33%" style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">
            <p style="margin:0;font-size:28px;font-weight:700;color:#22c55e">${aItems.length}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#64748b">A-varer (80% av plukk)</p>
          </td>
          <td width="33%" style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">
            <p style="margin:0;font-size:28px;font-weight:700;color:#f97316">${bItems.length}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#64748b">B-varer (15% av plukk)</p>
          </td>
          <td width="33%" style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center">
            <p style="margin:0;font-size:28px;font-weight:700;color:#94a3b8">${cItems.length}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#64748b">C-varer (resterende)</p>
          </td>
        </tr>
      </table>

      <!-- Hot zone efficiency -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#eff6ff;border-radius:8px;padding:16px;border:1px solid #bfdbfe">
        <tr>
          <td>
            <p style="margin:0;font-size:13px;font-weight:600;color:#1e40af">🔥 Hot zone-effektivitet</p>
            <p style="margin:6px 0 0;font-size:13px;color:#1e293b">
              <strong>${aInHot.length} av ${aItems.length} A-varer</strong> er plassert i hot zone.
              ${aMisplaced.length > 0
                ? `<span style="color:#dc2626"> ${aMisplaced.length} A-varer ligger utenfor hot zone.</span>`
                : '<span style="color:#22c55e"> Alle A-varer er korrekt plassert! ✓</span>'}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- Zone stats -->
  <tr>
    <td style="padding:24px 32px 8px">
      <h2 style="margin:0 0 12px;font-size:15px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Plukk per sone</h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Sone</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">7 dager</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">I dag</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Produkter</th>
          </tr>
        </thead>
        <tbody>${zoneRows}</tbody>
      </table>
    </td>
  </tr>

  ${aMisplaced.length > 0 ? `
  <!-- Misplaced A-items -->
  <tr>
    <td style="padding:24px 32px 8px">
      <h2 style="margin:0 0 4px;font-size:15px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">A-varer utenfor hot zone</h2>
      <p style="margin:0 0 12px;font-size:12px;color:#94a3b8">Disse bør flyttes til hot zone for å redusere plukktid</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">SKU</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Produkt</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Plassering</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Sone</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#64748b;font-weight:600">Plukk</th>
          </tr>
        </thead>
        <tbody>${misplacedRows}</tbody>
      </table>
    </td>
  </tr>` : ''}

  ${candidates.length > 0 ? `
  <!-- Move candidates -->
  <tr>
    <td style="padding:24px 32px 8px">
      <h2 style="margin:0 0 4px;font-size:15px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Flytt ut av hot zone</h2>
      <p style="margin:0 0 12px;font-size:12px;color:#94a3b8">Produkter med EOL/deaktivert status som opptar plass i hot zone</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">SKU</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Produkt</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Status</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Plassering</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600">Siste bevegelse</th>
          </tr>
        </thead>
        <tbody>${candidateRows}</tbody>
      </table>
    </td>
  </tr>` : ''}

  <!-- Footer -->
  <tr>
    <td style="padding:24px 32px;border-top:1px solid #f1f5f9;margin-top:16px">
      <p style="margin:0;font-size:12px;color:#94a3b8">Generert automatisk av Instock Dashboard · ${config.customer_short || ''} Lager</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.log('Fetching data from Supabase...');
  const data = await fetchData();
  console.log(`  zones: ${data.zones.length}, hotzone items: ${data.hotzone.length}, candidates: ${data.candidates.length}`);

  console.log('Building HTML report...');
  const html = buildHtml(data);

  const weekStr = new Date().toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const subject = `Ukentlig slottingsrapport — ${data.config.customer_short || 'Lager'} ${weekStr}`;

  console.log('Authenticating with Microsoft Graph...');
  const token = await getGraphToken();

  console.log(`Sending report to ${process.env.REPORT_TO_EMAIL}...`);
  await sendMail(token, subject, html);

  console.log('✓ Report sent successfully');
}

main().catch(err => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
