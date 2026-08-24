/**
 * Boot smoke test: evaluates EVERY script referenced by index.html in the same
 * order, inside jsdom, exactly like the PWA does. Fails if any module throws at
 * load time, then runs a minimal render sanity check.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// mirror index.html script order (rewritten to the flat repo layout)
const SCRIPTS = [
  'config.js', 'client.js', 'app.js', 'reminder-engine.js', 'sow-tools.js', 'pedigree.js',
  'lineage.js', 'sidebar.js', 'registration-security.js', 'drilldown.js', 'modal-layer.js',
  'medicine.js', 'piglet-ledger.js', 'foster-batch.js', 'ble-scale.js', 'batch-performance.js',
  'reservations.js', 'cull.js', 'logo-custom.js', 'reservation-summary-edit.js', 'qrcode-generator.js',
  'html2canvas.min.js', 'reservation-certificate.js', 'semen-sales.js', 'vet-library.js',
  'medicine-inventory.js', 'ai-vet-search.js', 'boar-registry.js', 'fattener-center.js',
  'feeding-guide.js', 'feed-orders.js', 'piglet-care.js', 'vaccination-center.js', 'zxing.min.js',
  'rfid-scanner.js', 'barn-movements.js', 'sow-monitoring.js', 'farm-admin.js', 'invite-share.js',
  'financial-statements.js', 'production-control.js', 'collapsible-content.js', 'batch-delete.js',
  'cloud-sync.js', 'register-sw.js'
];

function makeDom() {
  return new JSDOM(`<!doctype html><html><body>
    <div id="loginError"></div><div id="authStatus"></div>
    <div id="dashboard"></div><div id="predictor"></div><div id="production"></div>
    <div id="subscription"></div><div id="useradmin"></div>
    <div id="toast"></div><div id="modalBg"></div><div id="recordForm"></div>
    <div id="formFields"></div><div id="modalTitle"></div><div id="modalDesc"></div>
    <div id="farmSelect"></div><div id="farmLabel"></div><div id="pageTitle"></div>
    <div id="sows"></div><div id="piglets"></div><div id="feed"></div>
    <div id="semen"></div><div id="reminders"></div><div id="financials"></div>
    <div id="pos"></div><div id="reservations"></div><div id="vaccination"></div>
    <div id="barns"></div><div id="rfid"></div><div id="pedigree"></div>
    <div id="medicine"></div>
    <div id="loginScreen"></div><div id="onboardScreen"></div><div id="joinFarmScreen"></div>
    <nav id="nav"></nav>
  </body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
}

let w;
before(() => {
  const dom = makeDom();
  w = dom.window;
  w.structuredClone = globalThis.structuredClone;
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  // keep the test from hanging on the app's background heartbeat intervals
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  const errors = [];
  for (const file of SCRIPTS) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) { errors.push(`missing file: ${file}`); continue; }
    const code = fs.readFileSync(p, 'utf8');
    try { w.eval(code); } catch (e) { errors.push(`${file}: ${e.message}`); }
  }
  if (errors.length) throw new Error('LOAD ERRORS:\n' + errors.join('\n'));
});

describe('ARSwineTech Pro — full boot smoke test', () => {
  test('all index.html scripts evaluate with no load-time errors', () => {
    assert.ok(w.ARSCloud, 'ARSCloud defined');
    assert.ok(w.F, 'F() defined');
    assert.ok(w.localToday, 'localToday defined');
    assert.ok(w.getPigletCounts, 'getPigletCounts defined (piglet-ledger)');
    assert.ok(w.liveHeadsFor, 'liveHeadsFor defined');
    assert.ok(w.feedForecast, 'feedForecast defined');
    assert.ok(w.production, 'production defined');
    assert.ok(w.ARSFinance, 'ARSFinance defined');
    assert.ok(w.openConflictReview, 'openConflictReview defined (cloud-sync)');
    assert.ok(w.computeFeedPlan, 'computeFeedPlan defined (feeding-guide)');
  });

  test('feedForecast + counts + production run against a seeded farm without throwing', () => {
    const f = {
      name: 'Boot Farm', sows: [{ id: 'S-1', name: 'Bella', insemination: '2026-05-01', breed: 'Landrace' }],
      piglets: [{ id: 'B-1', birth: '2026-06-01', males: 10, females: 10, breed: 'F1', dam_name: 'Bella', sire_name: 'Thor' }],
      pigletLedger: [{ id: 'L-1', batch_id: 'B-1', type: 'fattener', gender: 'male', quantity: 3, status: 'active', source: 'fattener' }],
      feed: [{ type: 'Grower', bags: 5, price: 1250 }], semen: [], transactions: [], sales: [], reminders: [],
      medicines: [], vaccinations: [], reservations: [], semenSales: [], semenResellers: [],
      semenResellerTx: [], semenResellerAdjustments: [], feedTrials: [], feedOrders: [], boars: [],
      barns: [], movements: [], rfid_tags: [], rfid_scans: [], breedingRecords: [], heatRecords: [],
      treatments: [], med_movements: [], vaccination_events: [], vaxSchedules: [], vetCatalog: [],
      marketQuotes: [], productionEvents: [], feedAllocations: [], auditLog: [], integrationEvents: [],
      populationSnapshots: [], benchmarkProfiles: [], feedDuplicateRecovery: [], nutrition: {}
    };
    w.DB = w.DB || {};
    w.DB['farm-boot'] = f;
    w.farmId = 'farm-boot';
    w.window.farmId = 'farm-boot';
    const counts = w.getPigletCounts(f.piglets[0]);
    assert.equal(counts.fattener, 3);
    const fc = w.feedForecast(30);
    assert.equal(typeof fc.totals['Grower'], 'number');
    assert.ok(fc.totals['Finisher'] >= 0);
    w.setForecastTimeframe('all');
    w.production();
    assert.ok(w.document.getElementById('production').innerHTML.includes('Scheduled Wean') ||
              w.document.getElementById('production').innerHTML.length > 100);
  });
});
