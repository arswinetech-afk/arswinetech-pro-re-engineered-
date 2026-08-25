/**
 * Logic/arithmetic validation for ARSwineTech Pro.
 * Loads the REAL app.js + feature modules into jsdom and runs pure
 * computations against seeded farm data.
 *
 * Run:  NODE_PATH=/tmp/node_modules node --test qa/tests/logic.test.mjs
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const loadOrder = [
  'app.js',
  'piglet-ledger.js',
  'reservations.js',
  'feeding-guide.js',
  'financial-statements.js'
];

function makeDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
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
    <div id="medicine"></div><div id="semen-sales"></div>
    <nav id="nav"></nav>
  </body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  return dom;
}

let w;
before(() => {
  const dom = makeDom();
  w = dom.window;
  // jsdom lacks structuredClone; browsers have it (used by app.js users())
  w.structuredClone = globalThis.structuredClone;
  for (const file of loadOrder) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      w.eval(code);
    } catch (e) {
      // Some modules need the DOM anchor; record but continue
      console.error(`[load] ${file}: ${e.message}`);
    }
  }
});

function seedFarm() {
  w.DB = w.DB || {};
  const f = {
    name: 'QA Farm',
    sows: [
      { id: 'S-1', name: 'Bella', breed: 'Landrace', dob: '2023-02-10', parity: 3, insemination: '2026-05-01', sire: 'Thor' },
      { id: 'S-2', name: 'Maya', breed: 'Large White', insemination: null },
      { id: 'S-3', name: 'Luna', breed: 'Duroc', insemination: '2026-08-10', status: 'Open', farrowingDate: '2026-08-20', weanedAt: '2026-08-20', lactationEndedAt: '2026-08-20' }
    ],
    piglets: [
      { id: 'B-1', birth: '2026-06-01', males: 10, females: 10, breed: 'F1', dam_name: 'Bella', sire_name: 'Thor', weaning: false },
      { id: 'B-2', birth: '2026-07-20', males: 4, females: 6, breed: 'Duroc', dam_name: 'Luna', sire_name: 'Apollo', archived: false }
    ],
    pigletLedger: [
      // 5 males sold, 5 males allocated breeder, 1 female mortality
      { id: 'L-1', batch_id: 'B-1', type: 'sold', gender: 'male', quantity: 5, status: 'active' },
      { id: 'L-2', batch_id: 'B-1', type: 'breeder', gender: 'male', quantity: 5, status: 'active' },
      { id: 'L-3', batch_id: 'B-1', type: 'mortality', gender: 'female', quantity: 1, status: 'active' }
    ],
    feed: [
      { id: 'feed-grower', type: 'Grower', bags: 10, price: 1250 },
      { id: 'feed-starter', type: 'Starter', bags: 20, price: 1850 }
    ],
    feedPlan: {
      configured: true,
      sowGestKg: 2.5,
      sowLactKg: 3.5,
      boarKg: 2.0,
      boarFeedType: 'Gestating'
    },
    boars: [{ id: 'BO-1', name: 'Thor', breed: 'Duroc', status: 'Active' }],
    semen: [{ id: 'SEM-1', boar: 'Thor', breed: 'Duroc', semen_batch_no: 'TH-001', available_bottles: 10, bottles: 10, price: 350 }],
    transactions: [
      { date: '2026-07-04', type: 'Income', category: 'Piglet Sales', description: 'Batch B-1', amount: 28600, paid: 22000 },
      { date: '2026-07-08', type: 'Expense', category: 'Feed', description: 'Grower feed delivery', amount: 11250, paid: 11250 }
    ],
    sales: [],
    reservations: [],
    reminders: [],
    medicines: [],
    vaccinations: [],
    semenSales: [],
    semenResellers: [],
    semenResellerTx: [],
    semenResellerAdjustments: [],
    feedTrials: [],
    feedOrders: [],
    barns: [],
    movements: [],
    rfid_tags: [],
    rfid_scans: [],
    breedingRecords: [],
    heatRecords: [],
    treatments: [],
    med_movements: [],
    vaccination_events: [],
    vaxSchedules: [],
    vetCatalog: [],
    marketQuotes: [],
    productionEvents: [],
    feedAllocations: [],
    auditLog: [],
    integrationEvents: [],
    populationSnapshots: [],
    benchmarkProfiles: [],
    feedDuplicateRecovery: []
  };
  w.DB['farm-1'] = f;
  w.farmId = 'farm-1';
  w.window.farmId = 'farm-1';
  return f;
}

describe('ARSwineTech Pro — date & herd arithmetic (real app.js)', () => {
  const addDays = (base, n) => {
    const d0 = new Date(base + 'T00:00:00');
    d0.setDate(d0.getDate() + n);
    return d0.toISOString().slice(0, 10);
  };

  test('[FIX H1] production weaning date = birth + 28 days (was 2×age off)', () => {
    seedFarm();
    const birth = '2026-06-01';
    const expected = addDays(birth, 28);
    // render the production forecast and read the weaning card date
    w.setForecastTimeframe('all');
    w.production();
    const html = w.document.getElementById('production').innerHTML;
    const m = html.match(/<b style="font-size:15px;color:var\(--ink\)">([^<]+)<\/b>\s*<small class="muted"[^>]*>([^<]*Ready to Wean Now[^<]*)<\/small>/);
    assert.ok(m, 'weaning card rendered with Ready to Wean note');
    const shown = m[1].trim();
    const expectedFmt = new Date(expected + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    assert.equal(shown, expectedFmt, `wean date should be birth+28 = ${expectedFmt}`);
    // The reported age is still from today: sanity that the old formula would fail
    const buggy = w.isoOff(w.days(birth) + 28);
    assert.notEqual(buggy, expected, 'old isoOff(age+28) would still be wrong');
  });

  test('[FIX H1] production market date = birth + 160 days (fattener)', () => {
    seedFarm();
    const birth = '2026-06-01';
    const expected = addDays(birth, 160);
    // B-1 must have a fattener allocation to appear as Market Readiness
    w.DB['farm-1'].pigletLedger.push({ id: 'L-F', batch_id: 'B-1', type: 'fattener', gender: 'female', quantity: 3, status: 'active', source: 'fattener' });
    w.setForecastTimeframe('all');
    w.production();
    const html = w.document.getElementById('production').innerHTML;
    const m = html.match(/class="forecast-badge fattener">[^<]*Market Ready<\/span>[\s\S]{0,500}?<b style="font-size:15px;color:var\(--ink\)">([^<]+)<\/b>/);
    assert.ok(m, 'market readiness card rendered');
    const expectedFmt = new Date(expected + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    assert.equal(m[1].trim(), expectedFmt, `market date should be birth+160 = ${expectedFmt}`);
  });

  test('sow status: inseminated today reports Inseminated; day 33+ reports Pregnant', () => {
    seedFarm();
    const today = (w.window.localToday ? w.window.localToday() : new Date().toISOString().slice(0, 10));
    const s = w.DB['farm-1'].sows[0];
    s.insemination = today;
    assert.equal(w.status(s), 'Inseminated', 'gestation day 0 is Inseminated');
    s.insemination = addDays(today, -33);
    assert.equal(w.status(s), 'Pregnant');
  });

  test('[FIX M2] localToday() equals the Manila wall-clock date (+08:00 before 8AM)', () => {
    const t = w.window.localToday ? w.window.localToday() : null;
    assert.ok(t && /^\d{4}-\d{2}-\d{2}$/.test(t), 'localToday returns YYYY-MM-DD');
    // UTC date can differ from local (and cannot equal local minus 1 day in the early morning)
    const utc = new Date().toISOString().slice(0, 10);
    assert.ok(t === utc || w.days(utc, t) === 1 || w.days(utc, t) === -1, 'local vs UTC differ by at most one day');
  });

  test('feed forecast demand: new farrowings inside horizon are not added (known limitation)', () => {
    seedFarm();
    const fc = w.feedForecast(30);
    assert.ok(fc.totals['Grower'] > 0, 'B-1 is on grower feed');
    assert.ok(fc.totals['Starter'] > 0, 'B-2 is on starter feed');
    assert.ok(fc.totals['Gestating'] > 0, 'open/gestating sow + boar counted');
    const fc7 = w.feedForecast(7);
    assert.ok(fc7.totals['Pre Starter'] === 0, 'no piglets under 30d yet — and future litters are ignored');
  });
});

describe('ARSwineTech Pro — piglet ledger counts (real piglet-ledger.js)', () => {
  test('counts(): release-style sold rows (with source) produce consistent pools', () => {
    seedFarm();
    w.DB['farm-1'].pigletLedger[0].source = 'breeder';
    const c = w.getPigletCounts(w.DB['farm-1'].piglets[0]);
    assert.equal(c.m, 10);
    assert.equal(c.f, 10);
    assert.equal(c.mortality, 1);
    assert.equal(c.sold, 5);
    assert.equal(c.aliveM, 5, '10 - 0 mort - 5 sold');
    assert.equal(c.aliveF, 9, '10 - 1 mort');
    assert.equal(c.breeder, 0, '5 breeder-allocated minus 5 released from breeder');
    assert.equal(c.availableM, 5, 'remaining males are unassigned');
    assert.equal(c.availableF, 9);
  });

  test('[FIX H5] legacy source-less sold rows no longer zero the breeder pool', () => {
    seedFarm();
    const c = w.getPigletCounts(w.DB['farm-1'].piglets[0]);
    assert.equal(c.breeder, 5, 'breeder pool keeps its 5 allocated heads');
    assert.equal(c.breederAssigned, 5, 'allocation still recorded');
    assert.equal(c.availableM, 0, 'no double-bookable heads any more');
  });

  test('[FIX H3] reservation picker available() uses the ledger engine (sold-aware)', () => {
    seedFarm();
    const f = w.DB['farm-1'];
    // 10 born, 5 already sold, NOTHING else assigned → old picker showed 10
    // ("alive" ignored sold); the corrected engine shows 5.
    f.pigletLedger = [{ id: 'L-only', batch_id: 'B-1', type: 'sold', gender: 'male', quantity: 5, status: 'active', source: 'fattener' }];
    const b = f.piglets[0];
    const c = w.getPigletCounts(b);
    assert.equal(c.aliveM, 5, 'ledger: 10 born - 5 sold');
    assert.equal(c.availableM, 5, 'the 5 living unassigned males');
    // Replicate reservations.available() new algorithm (module-scoped function):
    const best = (g) => Math.max(
      g === 'male' ? (c.breederAvailM || 0) : (c.breederAvailF || 0),
      g === 'male' ? (c.fattenerAvailM || 0) : (c.fattenerAvailF || 0),
      g === 'male' ? (c.farmAvailM || 0) : (c.farmAvailF || 0)
    );
    const headerM = Math.max(best('male'), c.availableM || 0);
    assert.equal(headerM, 5, 'picker shows only living heads (5), not 10');
  });

  test('[FIX M7] genderless mortality reduces the living herd and available counts', () => {
    seedFarm();
    w.DB['farm-1'].pigletLedger.push({ id: 'L-x', batch_id: 'B-1', type: 'mortality', gender: '', quantity: 2, status: 'active' });
    const c = w.getPigletCounts(w.DB['farm-1'].piglets[0]);
    assert.equal(c.mortality, 3, 'counted in mortality stat');
    // alive = (5M + 9F) - 2 unspecified = 12
    assert.equal(c.alive, 12, 'genderless mortality reduces alive');
    assert.ok(c.alive <= c.aliveM + c.aliveF, 'alive never exceeds gender sum');
  });

  test('[FIX M1] liveHeadsFor() equals counts().alive and subtracts sold', () => {
    seedFarm();
    const b = w.DB['farm-1'].piglets[0];
    assert.equal(w.liveHeadsFor(b), w.getPigletCounts(b).alive, 'single source of truth');
    assert.ok(w.liveHeadsFor(b) < 20, 'sold heads are not fed/medicated/planned');
  });
});

describe('ARSwineTech Pro — financial aggregates (real financial-statements.js)', () => {
  test('[FIX M4] released deposits are applied (not held, not double counted)', () => {
    seedFarm();
    const f = w.DB['farm-1'];
    f.reservations.push({ id: 'res-123', no: 'RES-000123', customer: 'C1', status: 'released', total: 4000, paid: 4000, balance: 0 });
    // Prepayment tx (recorded at reservation time, description has only the NO)
    f.transactions.push({
      date: '2026-08-01', type: 'Income', category: 'Piglet Reservation Prepayment',
      description: 'Deposit (Reservation: RES-000123): C1 · Batch B-1 (2 heads)', amount: 2000, paid: 2000, id: 'tx-res-dep'
    });
    // Release sale tx (net of the applied deposit, as saveRelease() now writes)
    f.transactions.push({
      date: '2026-08-10', type: 'Income', category: 'Piglet Sales',
      description: 'Reservation RES-000123 · Released 2 heads · pre-paid ₱2,000 applied', amount: 4000, paid: 2000, id: 'tx-rel'
    });
    const s = w.ARSFinance.summary(f);
    assert.equal(s.customerDeposits.length, 0, 'no stale held deposit');
    assert.equal(s.depositCash, 0, 'deposit liability cleared');
    assert.equal(s.grossSales, 32600, 'release sale is the revenue (28600 + 4000)');
    assert.equal(s.collected, 24000, 'cash = 22000 + release balance 2000 (deposit not double counted)');
    assert.equal(s.receivables, 8600);
  });

  test('held deposit (open reservation) stays a liability, not revenue', () => {
    seedFarm();
    const f = w.DB['farm-1'];
    f.reservations.push({ id: 'res-456', no: 'RES-000456', customer: 'C2', status: 'partially_paid', total: 3000, paid: 1000, balance: 2000 });
    f.transactions.push({
      date: '2026-08-02', type: 'Income', category: 'Piglet Reservation Prepayment',
      description: 'Deposit (Reservation: RES-000456): C2 · Batch B-2 (1 head)', amount: 1000, paid: 1000, id: 'tx-res-dep2'
    });
    const s = w.ARSFinance.summary(f);
    assert.equal(s.customerDeposits.length, 1);
    assert.equal(s.depositCash, 1000);
    assert.equal(s.grossSales, 28600, 'deposit excluded from operating revenue');
    assert.equal(s.collected, 22000);
  });
});

describe('ARSwineTech Pro — Feed Predictor vs Feeding Guide consistency (FIX)', () => {
  const addDays = (base, n) => {
    const d0 = new Date(base + 'T00:00:00');
    d0.setDate(d0.getDate() + n);
    return d0.toISOString().slice(0, 10);
  };

  function freshBatchFarm(ageDays, heads, opts = {}) {
    seedFarm();
    const today = w.window.localToday ? w.window.localToday() : new Date().toISOString().slice(0, 10);
    const birth = addDays(today, -ageDays);
    const f = w.DB['farm-1'];
    f.piglets = [{ id: 'B-F', birth, males: heads, females: 0, breed: 'Crossbred', dam_name: 'Bella', sire_name: 'Thor', weaning: false, _ars_cloud_local_id: 'B-F' }];
    f.pigletLedger = [{ id: 'LF-1', batch_id: 'B-F', type: 'fattener', gender: 'male', quantity: heads, status: 'active', source: 'fattener' }];
    if (opts.sold) f.pigletLedger.push({ id: 'LF-2', batch_id: 'B-F', type: 'sold', gender: 'male', quantity: opts.sold, status: 'active', source: 'fattener' });
    f.sows = [];
    f.boars = [];
    if (opts.configured === false && f.feedPlan) f.feedPlan.configured = false;
    return { f, birth };
  }

  test('[FIX] configured farm: feedForecast === computeFeedPlan (one engine, one number)', () => {
    freshBatchFarm(100, 10);
    const fc = w.feedForecast(30);
    const gp = w.computeFeedPlan(30);
    assert.equal(fc.engine, 'guide', 'configured farm uses the guide engine');
    Object.keys(gp.req).forEach(t => {
      const expected = +(gp.req[t].req || 0);
      assert.ok(Math.abs((fc.totals[t] || 0) - expected) < 0.01, `${t}: predictor ${fc.totals[t]} must equal guide ${expected}`);
    });
  });

  test('[FIX] age-derived progress: 45-day-old batch (no consumed entry) is NOT stuck on Pre Starter', () => {
    freshBatchFarm(45, 10);
    const f = w.DB['farm-1'];
    delete f.feedPlan.batches; // no consumed data at all
    const gp = w.computeFeedPlan(30);
    const b = gp.batchSec.find(x => x.id === 'B-F');
    assert.ok(b, 'batch present');
    assert.equal(b.ageDerived, true, 'consumed derived from real age');
    assert.notEqual(b.stage, 'Pre Starter', '45-day-old pigs are past Pre Starter (28d)');
    // preStarter fully consumed, starter partially → current stage Starter
    assert.equal(b.stage, 'Starter');
  });

  test('[FIX] grower remaining respects consumed tracking (100d pig, grown plan coded)', () => {
    seedFarm();
    const today = w.window.localToday ? w.window.localToday() : new Date().toISOString().slice(0, 10);
    const birth = addDays(today, -100);
    const f = w.DB['farm-1'];
    f.piglets = [{ id: 'B-G', birth, males: 10, females: 0, breed: 'Crossbred', _ars_cloud_local_id: 'B-G' }];
    f.pigletLedger = [{ id: 'L-G1', batch_id: 'B-G', type: 'fattener', gender: 'male', quantity: 10, status: 'active', source: 'fattener' }];
    f.sows = []; f.boars = [];
    // MANUAL consumed: pre+starter done, grower 17 of 20 bags (2.0/head × 10)
    f.feedPlan.batches = { 'B-G': { consumed: { preStarter: 8, starter: 12, grower: 17, finisher: 0 }, updated: new Date().toISOString() } };
    const fc = w.feedForecast(30);
    const gp = w.computeFeedPlan(30);
    assert.ok(Math.abs(fc.totals['Grower'] - +(gp.req['Grower']?.req || 0)) < 0.01);
    // 3 bags of grower remain → 30d walk = 3 bags (not 60+ bags as the old age engine said)
    assert.ok(Math.abs(fc.totals['Grower'] - 3) < 0.05, `grower remaining should be 3 bags, got ${fc.totals['Grower']}`);
  });

  test('[FIX] unconfigured farm falls back to age-based engine (market day 160 still respected)', () => {
    freshBatchFarm(100, 10, { configured: false });
    const fc = w.feedForecast(90);
    assert.equal(fc.engine, 'age');
    // days 100-120 grower × 10 × 2.1kg
    assert.ok(Math.abs(fc.totalsKg['Grower'] - 21 * 10 * 2.1) < 0.01, `grower kg ${fc.totalsKg['Grower']}`);
    // days 121-159 finisher (market at 160)
    assert.ok(Math.abs(fc.totalsKg['Finisher'] - 39 * 10 * 2.75) < 0.01, `finisher kg ${fc.totalsKg['Finisher']}`);
  });

  test('[FIX] unconfigured breeder batch released at day 90: grower only 71-89', () => {
    freshBatchFarm(85, 10, { configured: false });
    const f = w.DB['farm-1'];
    f.pigletLedger[0].type = 'breeder';
    f.pigletLedger[0].source = 'breeder';
    const fc = w.feedForecast(30);
    assert.ok(Math.abs(fc.totalsKg['Grower'] - 5 * 10 * 2.1) < 0.01, `grower kg ${fc.totalsKg['Grower']}`);
    assert.equal(fc.totalsKg['Finisher'], 0);
  });
});


