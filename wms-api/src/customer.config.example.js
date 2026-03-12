// customer.config.example.js
// ─────────────────────────────────────────────────────────────
// Kopier denne til customer.config.js og fyll inn kundens verdier.
// customer.config.js skal ALDRI commites til Git.
//
// Instock-tabellstrukturen er standard — kun verdiene her varierer
// fra kunde til kunde.
// ─────────────────────────────────────────────────────────────

module.exports = {

  // ── Kundeinfo (vises i dashboard) ──────────────────────────
  customer: {
    name:         'Kundenavn AS',
    shortName:    'KUNDE',
    primaryColor: '#4f6ef7',   // hex-farge for accent i dashboard
  },

  // ── Lagerfilter ────────────────────────────────────────────
  // null  → henter fra alle lagre (vanligst)
  // tall  → filtrer på ett WAREHOUSE_ID, f.eks. 1
  warehouse: {
    id: null,
  },

  // ── Soner ──────────────────────────────────────────────────
  // id    → ZONE_ID i wms_zone (eksakt match, case-sensitiv)
  // name  → visningsnavn i dashboard
  // color → hex-farge for sonekortet
  // hot   → true = hot zone (varer herfra flagges som flytt-kandidater
  //         om de har "kald" status)
  zones: [
    { id: 'ZONE_A', name: 'Sone A', color: '#f5c518', hot: true  },
    { id: 'ZONE_B', name: 'Sone B', color: '#f97316', hot: true  },
    { id: 'ZONE_C', name: 'Sone C', color: '#22c55e', hot: false },
    { id: 'ZONE_D', name: 'Sone D', color: '#3b82f6', hot: false },
  ],

  // ── Produktstatuser som skal flyttes ut av hot zone ────────
  // Matcher wms_product_status.ID
  // Vanlige Instock-verdier: 2=EOL, 6=SESONGVARE, 9=DEAKTIVERT, 12=OUTLET
  coldStatusIds: [2, 6, 9, 12],

  // ── Systemplasseringer (ikke fysiske hylleplasser) ─────────
  // Transaksjoner til/fra disse utelates fra plukk-analyse.
  // Sjekk wms_location for plasseringsnavn som ikke er hylleplasser.
  systemLocations: [
    'MOTTAK',
    'Bermuda',
    // legg til kundespecifikke systemplasseringer her
  ],

};
