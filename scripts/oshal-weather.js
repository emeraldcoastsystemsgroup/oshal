#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — weather feed → trading gravity masses (ADR-054). Pulls LIVE severe/extreme alerts from the National Weather Service (api.weather.gov, FREE + keyless), tallies them by event type, and maps disaster demand into gravity masses for the home-improvement cohort (HD/LOW positive on rebuild, GNRC generators, BLDR roofing/lumber). Emits a masses bundle the gravity sim consumes. Pure Node, no key. This is the "weather bot" data half; weather-analyst.yaml is its reasoning persona.
 *
 *   node scripts/oshal-weather.js            # live NWS severe alerts → masses summary + JSON
 *   node scripts/oshal-weather.js --json     # print the masses bundle only
 *
 * Writes data/_extracted/masses/weather.json (merge into a gravity sim config).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NWS = 'https://api.weather.gov/alerts/active?status=actual';
const UA = 'OSHAL-IntelligentTrades/1.0 (maintainer@emeraldcoastsystemsgroup.com)';
const SEVERE = new Set(['Severe', 'Extreme']);

// Event family → cohort coupling (how that disaster pulls each name) + decay.
const PLAYS = [
  { match: /tornado|hurricane|tropical|storm surge/i, label: 'Major wind/water disaster', halfLifeDays: 21, coupling: { HD: 0.5, LOW: 0.5, GNRC: 0.9, BLDR: 0.85 } },
  { match: /thunderstorm|hail|flood/i, label: 'Severe storm/flood', halfLifeDays: 12, coupling: { HD: 0.45, LOW: 0.45, GNRC: 0.6, BLDR: 0.5 } },
  { match: /winter|blizzard|ice|snow/i, label: 'Winter storm', halfLifeDays: 10, coupling: { HD: 0.4, LOW: 0.4, GNRC: 0.8, BLDR: 0.2 } },
  { match: /fire|red flag|heat/i, label: 'Fire/heat', halfLifeDays: 14, coupling: { HD: 0.35, LOW: 0.35, GNRC: 0.7, BLDR: 0.25 } },
];

async function fetchAlerts() {
  const r = await fetch(NWS, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
  if (!r.ok) throw new Error(`NWS ${r.status}`);
  const j = await r.json();
  return (j.features || []).map((f) => f.properties || {}).filter((p) => SEVERE.has(p.severity));
}

/** Tally active alerts into the play families, weighting Extreme > Severe. */
function tally(alerts) {
  const counts = PLAYS.map((p) => ({ ...p, count: 0, extreme: 0 }));
  for (const a of alerts) {
    const ev = `${a.event || ''} ${a.headline || ''}`;
    for (const p of counts) if (p.match.test(ev)) { p.count++; if ((a.severity || '') === 'Extreme') p.extreme++; }
  }
  return counts.filter((p) => p.count > 0);
}

/** Build gravity masses (coupling form) from the tallies — mass scales with weighted alert volume. */
function toMasses(tallies) {
  return tallies.map((p) => {
    const weighted = p.count + p.extreme * 1.5;
    const mass = Math.min(1, weighted / 60);   // ~60 weighted alerts → full mass
    return { source: 'weather/nws', label: `${p.label} (${p.count} active)`, mass: round(mass), halfLifeDays: p.halfLifeDays, t0Day: 0, coupling: p.coupling };
  });
}

const round = (n) => Math.round(n * 100) / 100;

(async () => {
  const jsonOnly = process.argv.includes('--json');
  let alerts;
  try { alerts = await fetchAlerts(); } catch (e) { console.error('weather fetch failed: ' + e.message); process.exit(1); }
  const tallies = tally(alerts);
  const masses = toMasses(tallies);
  const bundle = { generatedAt: new Date().toISOString(), source: 'NWS active alerts', totalAlerts: alerts.length, severeMatched: tallies.reduce((s, t) => s + t.count, 0), masses };
  const outDir = path.join('data', '_extracted', 'masses'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'weather.json'), JSON.stringify(bundle, null, 2));
  if (jsonOnly) { console.log(JSON.stringify(bundle, null, 2)); return; }
  console.log(`\n  WEATHER → GRAVITY  ${bundle.generatedAt}`);
  console.log(`  ${alerts.length} active severe/extreme NWS alerts · ${bundle.severeMatched} matched a trading play\n`);
  if (!masses.length) { console.log('  No tradeable weather right now (calm = no disaster-demand mass).\n'); return; }
  for (const m of masses) console.log(`  ${m.label.padEnd(38)} mass ${String(m.mass).padStart(5)}  half-life ${m.halfLifeDays}d  → HD/LOW/GNRC/BLDR ${JSON.stringify(m.coupling)}`);
  console.log(`\n  wrote ${path.join(outDir, 'weather.json')} — feed into the gravity sim / decide path.\n`);
})();
