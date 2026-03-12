# Instock WMS Dashboard

Node.js/Express API-lag mellom Instock WMS (Azure SQL) og et lagerdashboard.
Dashboardet vises på storskjermer på lageret og auto-refresher hvert 15. minutt.

---

## Ny kundedeploy — tre steg

1. **`.env`** — database-tilkobling
2. **`src/customer.config.js`** — soner, statuskoder og kundenavn
3. `npm install && npm start`

Det er alt. Selve koden røres ikke.

---

## Oppsett

```bash
npm install

cp .env.example .env
# Fyll inn DB_NAME og DB_PASSWORD

cp src/customer.config.example.js src/customer.config.js
# Rediger customer.config.js med kundens soner og innstillinger

npm run dev     # utvikling (nodemon)
npm start       # produksjon
```

> `customer.config.js` og `.env` er i `.gitignore` — commites aldri.

Åpne **`http://localhost:3001`** i nettleseren for å se dashboardet.

---

## Konfigurasjon — `src/customer.config.js`

```js
module.exports = {
  customer: {
    name:         'Kundenavn AS',
    shortName:    'KUNDE',
    primaryColor: '#4f6ef7',
  },
  warehouse: {
    id: null,        // null = alle lagre, tall = filtrer på WAREHOUSE_ID
  },
  zones: [
    { id: 'ZONE_A', name: 'Sone A', color: '#f5c518', hot: true  },
    { id: 'ZONE_B', name: 'Sone B', color: '#f97316', hot: true  },
    // ... legg til/fjern soner etter behov
  ],
  coldStatusIds:   [2, 6, 9, 12],      // Flytt ut av hot zone
  systemLocations: ['MOTTAK', 'Bermuda', ...],
};
```

Dashboardet henter konfigurasjonen fra `/api/config` ved oppstart og bygger
sonekort, farger og kundenavn dynamisk.

---

## API-endepunkter

| Metode | URL | Beskrivelse |
|--------|-----|-------------|
| GET | `/api/config` | Kundekonfigurasjon (soner, farger, kundenavn) |
| GET | `/api/health` | Helsesjekk |
| GET | `/api/zones` | Plukk-aktivitet per sone |
| GET | `/api/zones/hotzone` | Topp-N varer etter pick-frekvens |
| GET | `/api/zones/move-suggest` | Flytt-kandidater i hot zone |
| GET | `/api/zones/stock` | Lagerbeholdning per lokasjon |
| GET | `/api/orders` | Ordrer og pipeline-telling |
| GET | `/api/orders/picklist/:id` | Plukklister for én operatør |
| GET | `/api/operators` | Alle operatører med transaksjonsfordeling |
| GET | `/api/operators/:id` | Historisk breakdown for én operatør |
| GET | `/api/inbound` | Innkommende leveranser |
| GET | `/api/inbound/mottak` | Mottakstransaksjoner |
| GET | `/api/inbound/flow` | Intern soneflytt |
| GET | `/api/inbound/history` | Transaksjonshistorikk |

**Query-parametere:**
```
/api/zones?days=7
/api/zones/hotzone?days=7&limit=20
/api/zones/stock?zone=ZONE_A&limit=50
/api/operators?date=2026-03-12
/api/operators/:id?days=7
/api/inbound/mottak?days=1
/api/inbound/flow?hours=24
/api/inbound/history?hours=24
```

---

## Transaksjonstyper

Typen bestemmes av `LOCATION_ID` / `LOCATION_FROM_ID`:

| Type | Regel |
|------|-------|
| **Plukk** | `LOCATION_FROM_ID` = hylleplass (ikke systemplassering) |
| **Varemottak** | `LOCATION_ID = 'MOTTAK'` |
| **Retur** | `LOCATION_ID = 'Bermuda'` |
| **Vareflytt** | Begge = hylleplass, ulik sone |

---

## Neste steg

- [ ] Autentisering på API (JWT eller API-nøkkel)
- [ ] Deploy til Azure App Service eller Azure Container
- [ ] WebSocket i stedet for 15-minutters polling
