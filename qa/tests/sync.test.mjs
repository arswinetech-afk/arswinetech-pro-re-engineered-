/**
 * Multi-device cloud-sync validation for ARSwineTech Pro.
 * Executes the REAL client.js in isolated VM sandboxes (two "devices")
 * against one shared FakeSupabase server.
 *
 * Run:  node --test qa/tests/sync.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeSupabase, makeFetcher, makeStorage } from './fake-supabase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLIENT = path.join(ROOT, 'client.js');

const SUPABASE_URL = 'https://hgmrltewkxjmhlqevjrp.supabase.co';
const ANON = 'sb_publishable_TEST';

function loadDevice(db, name) {
  const sandbox = {
    fetch: makeFetcher(db),
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    navigator: { onLine: true },
    console,
    URLSearchParams, URL, URLSearchParams, Date, Math, JSON, Map, Set, Object, Array, Number, String, Boolean, Error, Promise, RegExp, Intl,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { hash: '', pathname: '/', origin: 'https://app.test', search: '' },
    history: { replaceState() {} },
    document: { title: '' },
    __deviceName: name
  };
  sandbox.window = sandbox;
  sandbox.window.ARS_SUPABASE_CONFIG = { url: SUPABASE_URL, anonKey: ANON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' });
  return sandbox;
}

async function signIn(dev, email, password) {
  const user = await dev.ARSCloud.signIn(email, password);
  assert.ok(user?.id, 'sign-in returns user');
  return user;
}

/** Pull farm-1 baseline into device, set the context flags like app.js does. */
async function activateFarm(dev, farmId = 'farm-1') {
  dev.farmId = farmId;
  dev.window.farmId = farmId;
  dev.window.__arsActiveFarmId = farmId;
  dev.window.arsContextReady = true;
  dev.window.__arsCloudBaselineReady = false;
  dev.window.DB = dev.window.DB || {};
  if (!dev.window.DB[farmId]) dev.window.DB[farmId] = {
    name: 'Test Hog Farm', sows: [], piglets: [], feed: [], semen: [], transactions: [], sales: [],
    reminders: [], medicines: [], vaccinations: [], reservations: [], semenSales: [], semenResellers: [],
    semenResellerTx: [], semenResellerAdjustments: [], feedTrials: [], feedOrders: [], boars: [], barns: [],
    movements: [], rfid_tags: [], rfid_scans: [], breedingRecords: [], pigletLedger: [], heatRecords: [],
    treatments: [], med_movements: [], vaccination_events: [], vaxSchedules: [], vetCatalog: [], marketQuotes: [],
    productionEvents: [], feedAllocations: [], auditLog: [], integrationEvents: [], populationSnapshots: [],
    benchmarkProfiles: [], feedDuplicateRecovery: []
  };
  const res = await dev.ARSCloud.pullFarm(farmId, { allowDirty: true });
  assert.equal(res.success, true, `pull baseline: ${res.reason || ''}`);
  dev.window.__arsCloudBaselineReady = true;
  return res;
}

/** Make a local edit through the same path app.js uses: mutate + markLocalChanges. */
function editFarm(dev, farmId, mutator) {
  const farm = dev.window.DB[farmId];
  const prev = JSON.parse(JSON.stringify(farm));
  mutator(farm);
  dev.window.__arsLastSavedFarmById = dev.window.__arsLastSavedFarmById || {};
  const marked = dev.ARSCloud.markLocalChanges(farmId, prev, farm);
  dev.window.__arsLastSavedFarmById = dev.window.__arsLastSavedFarmById || {};
  dev.window.__arsLastSavedFarmById[farmId] = JSON.parse(JSON.stringify(farm));
  return marked;
}

function makeFarm(db, email = 'dev1@test.ph', password = 'secret123') {
  db.addUser(email, password, { email });
  return { db, email, password };
}

describe('ARSwineTech Pro — multi-device sync engine (real client.js)', () => {
  test('round trip: pull → local edit → push → device 2 sees the row', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    const marked = editFarm(dev1, 'farm-1', f => {
      f.sows.push({ id: 'S-100', name: 'Testa', breed: 'Landrace', insemination: '2026-08-01' });
    });
    assert.equal(marked, 1, 'one new row marked dirty');

    const push = await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(push.success, true, `push ok: ${push.reason || ''}`);
    assert.equal(push.count, 1);
    assert.equal(db.rowCount('farm-1'), 1, 'server has 1 app_record');
    assert.equal(dev1.ARSCloud.hasDirtyChanges('farm-1'), false, 'dirty cleared after push');

    const pull2 = await dev2.ARSCloud.pullFarm('farm-1');
    assert.equal(pull2.success, true);
    assert.equal(dev2.window.DB['farm-1'].sows.length, 1);
    assert.equal(dev2.window.DB['farm-1'].sows[0].id, 'S-100');
    assert.equal(dev2.window.DB['farm-1'].sows[0]._ars_cloud_local_id, 'S-100');
  });

  test('conflict: stale device B cannot silently overwrite newer remote row; blocked and preserved', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    // The row exists in BOTH devices' baselines (typical shared herd)
    db.seedRow('farm-1', 'sow', 'S-200', { id: 'S-200', name: 'Alpha', insemination: '2026-08-01', _ars_cloud_local_id: 'S-200' });
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    // Device 1 edits first and uploads
    editFarm(dev1, 'farm-1', f => { f.sows.find(s => s.id === 'S-200').name = 'Alpha-Edited'; });
    const p1 = await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(p1.success, true, `dev1 push: ${p1.reason || ''}`);

    // Device 2 (stale baseline) edits the same row
    const marked = editFarm(dev2, 'farm-1', f => { f.sows.find(s => s.id === 'S-200').name = 'Beta'; });
    assert.equal(marked, 1);
    const p2 = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(p2.success, false, 'second device push must be blocked');
    assert.equal(p2.conflicts.length, 1, 'conflict reported');
    assert.equal(dev2.ARSCloud.hasDirtyChanges('farm-1'), true, 'conflicting local edit is preserved as dirty');

    // Server must still hold device 1's (first-writer) value
    const serverRow = [...db.rows.values()][0];
    assert.equal(serverRow.payload.name, 'Alpha-Edited', 'first writer wins; stale write never applied');

    // Background pull from the stale device must be blocked while dirty
    const pull = await dev2.ARSCloud.pullFarm('farm-1');
    assert.equal(pull.success, false, 'pull blocked while dirty rows exist');
    assert.match(pull.reason, /Pending local changes/i);
  });

  test('allowDirty pull replaces bucket but preserves recovery snapshot (known data-loss escape)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    db.seedRow('farm-1', 'sow', 'S-999', { id: 'S-999', name: 'Shared', insemination: '2026-08-03', _ars_cloud_local_id: 'S-999' });
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    // Device 1 wins the race: edits S-999 and uploads
    editFarm(dev1, 'farm-1', f => { f.sows.find(s => s.id === 'S-999').name = 'RemoteWins'; });
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });

    // Device 2 (stale) edits the same sow locally → conflict on push
    editFarm(dev2, 'farm-1', f => { f.sows.find(s => s.id === 'S-999').name = 'LocalEdit'; });
    const blocked = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(blocked.success, false);
    assert.equal(dev2.ARSCloud.hasDirtyChanges('farm-1'), true);

    // The hidden escape: activateFarmContext-style pull with allowDirty discards the dirty local edit
    const escape = await dev2.ARSCloud.pullFarm('farm-1', { allowDirty: true });
    assert.equal(escape.success, true);
    assert.equal(dev2.ARSCloud.hasDirtyChanges('farm-1'), false, 'dirty rows cleared by allowDirty pull');
    assert.equal(dev2.window.DB['farm-1'].sows.find(s => s.id === 'S-999').name, 'RemoteWins', 'local edit silently replaced');
    // But a recovery snapshot was preserved
    const snapshots = dev2.ARSCloud.listLocalRecoverySnapshots();
    assert.ok(snapshots.length >= 1, 'recovery snapshot exists');
  });

  test('cloud delete then pull does not resurrect a row', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    editFarm(dev1, 'farm-1', f => f.sows.push({ id: 'S-400', name: 'Doomed', insemination: '2026-08-05' }));
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    await dev2.ARSCloud.pullFarm('farm-1');

    // delete via the same path sow-tools.js uses
    await dev1.ARSCloud.deleteAppRecord('farm-1', 'sow', 'S-400');
    dev1.window.DB['farm-1'].sows = dev1.window.DB['farm-1'].sows.filter(s => s.id !== 'S-400');
    dev1.window.__arsLastSavedFarmById['farm-1'] = JSON.parse(JSON.stringify(dev1.window.DB['farm-1']));

    const pull2 = await dev2.ARSCloud.pullFarm('farm-1');
    assert.equal(pull2.success, true);
    assert.equal(dev2.window.DB['farm-1'].sows.find(s => s.id === 'S-400'), undefined, 'no resurrection');
    assert.equal(db.rowCount('farm-1'), 0);
  });

  test('feed inventory upsert keeps single balance row per type; duplicates preserved in recovery ledger', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    editFarm(dev1, 'farm-1', f => f.feed.push({ type: 'Grower', bags: 10, price: 1250 }));
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });

    // Device 2 pulls, then edits the same feed type (same keys thanks to sanitizeFarm ids)
    await dev2.ARSCloud.pullFarm('farm-1');
    const feed = dev2.window.DB['farm-1'].feed[0];
    assert.ok(feed._ars_cloud_local_id || feed.id, 'feed row has stable local id');
    editFarm(dev2, 'farm-1', f => { f.feed[0].bags = 12; });
    const res = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(res.success, true, 'same-key feed row updates in place');
    assert.equal(db.rowCount('farm-1'), 1, 'no duplicate feed row');
  });

  test('legacy rows without business ids keep their cloud local id (no index drift)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);

    // A legacy cloud row pre-dating synthetic ids: no id, no _ars_cloud_local_id
    db.seedRow('farm-1', 'transaction', 'transaction-2', { date: '2026-07-04', type: 'Income', category: 'Piglet Sales', description: 'Batch A', amount: 28600, paid: 22000 });
    await activateFarm(dev1);
    await activateFarm(dev2);

    // Pull attaches the cloud local id to the payload — stable across devices
    const tx = dev1.window.DB['farm-1'].transactions[0];
    assert.ok(tx._ars_cloud_local_id, 'cloud local id attached on pull');
    assert.equal(tx._ars_cloud_local_id, 'transaction-2');

    // Editing then pushing updates the SAME server key (no duplicate)
    editFarm(dev1, 'farm-1', f => { f.transactions[0].amount = 30000; });
    const push = await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(push.success, true);
    assert.equal(db.rowCount('farm-1'), 1, 'same row updated in place');

    // Device 2 could also edit it without creating a duplicate
    await dev2.ARSCloud.pullFarm('farm-1');
    editFarm(dev2, 'farm-1', f => { f.transactions[0].paid = 30000; });
    const push2 = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(push2.success, true);
    assert.equal(db.rowCount('farm-1'), 1);
  });

  test('new legacy-style rows (no business id) get unique synthetic ids per device', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    editFarm(dev1, 'farm-1', f => f.transactions.push({ date: '2026-08-01', type: 'Expense', category: 'Feed', description: 'Grower delivery', amount: 12500, paid: 12500 }));
    editFarm(dev2, 'farm-1', f => f.transactions.push({ date: '2026-08-02', type: 'Income', category: 'Piglet Sales', description: 'Batch B', amount: 40000, paid: 30000 }));
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(db.rowCount('farm-1'), 2, 'two distinct rows, no key collision');

    // Pull both into device 1 without duplication
    await dev1.ARSCloud.pullFarm('farm-1');
    assert.equal(dev1.window.DB['farm-1'].transactions.length, 2);
  });

  test('same-name rows in separate entities do not collide (farm+type scope)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev = loadDevice(db, 'dev1');
    await signIn(dev, email, password);
    await activateFarm(dev);
    editFarm(dev, 'farm-1', f => {
      f.sows.push({ id: 'X1', name: 'Same', insemination: '2026-08-01' });
      f.boars.push({ id: 'B1', name: 'Same', status: 'Active' });
    });
    const res = await dev.ARSCloud.pushFarm('farm-1', dev.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(res.success, true);
    assert.equal(db.rowCount('farm-1'), 2, 'entity type keeps keys distinct');
  });

  test('push is blocked before verified baseline (safety gate works)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev = loadDevice(db, 'dev1');
    await signIn(dev, email, password);
    dev.window.__arsActiveFarmId = 'farm-1';
    dev.window.arsContextReady = true;
    dev.window.__arsCloudBaselineReady = false;
    dev.window.DB = { 'farm-1': { name: 'X', sows: [{ id: 'S-1', name: 'No' }] } };
    const res = await dev.ARSCloud.pushFarm('farm-1', dev.window.DB['farm-1'], { dirtyOnly: false });
    assert.equal(res.success, false);
    assert.match(res.reason, /baseline/i);
    assert.equal(db.rowCount('farm-1'), 0, 'nothing uploaded without baseline');
  });

  test('session refresh keeps working across devices (auth layer)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    const dev = loadDevice(db, 'dev1');
    db.addUser(email, password, { email });
    const user = await signIn(dev, email, password);
    assert.ok(user.id);
    const info = dev.ARSCloud.sessionInfo();
    assert.equal(info.token_present, true);
    assert.equal(info.has_refresh_token, true);
    // restoreSession revalidates
    const restored = await dev.ARSCloud.restoreSession();
    assert.equal(restored.verified, true);
  });
});

describe('ARSwineTech Pro — FIX C2 conflict resolution & FIX C3 delete queue', () => {
  test('[FIX C2] resolveConflict("local") adopts baseline then push succeeds (deliberate keep-mine)', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    db.seedRow('farm-1', 'sow', 'S-500', { id: 'S-500', name: 'Remote', insemination: '2026-08-01', _ars_cloud_local_id: 'S-500' });
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    editFarm(dev1, 'farm-1', f => { f.sows.find(s => s.id === 'S-500').name = 'Remote-Edited'; });
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });

    editFarm(dev2, 'farm-1', f => { f.sows.find(s => s.id === 'S-500').name = 'My-Edit'; });
    const blocked = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(blocked.success, false);

    // The review UI calls resolveConflict(local) for the row, then pushes again
    const c = blocked.conflicts[0];
    const resolved = dev2.ARSCloud.resolveConflict('farm-1', c, 'local');
    assert.equal(resolved.success, true);
    const repush = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(repush.success, true, 'local value accepted deliberately: ' + repush.reason);
    const serverRow = [...db.rows.values()][0];
    assert.equal(serverRow.payload.name, 'My-Edit');
  });

  test('[FIX C2] resolveConflict("remote") drops the dirty flag so a pull brings the cloud value', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    db.seedRow('farm-1', 'sow', 'S-501', { id: 'S-501', name: 'Cloud', insemination: '2026-08-01', _ars_cloud_local_id: 'S-501' });
    const dev1 = loadDevice(db, 'dev1');
    const dev2 = loadDevice(db, 'dev2');
    await signIn(dev1, email, password);
    await signIn(dev2, email, password);
    await activateFarm(dev1);
    await activateFarm(dev2);

    editFarm(dev1, 'farm-1', f => { f.sows.find(s => s.id === 'S-501').name = 'Cloud-Wins'; });
    await dev1.ARSCloud.pushFarm('farm-1', dev1.window.DB['farm-1'], { dirtyOnly: true });
    editFarm(dev2, 'farm-1', f => { f.sows.find(s => s.id === 'S-501').name = 'Local-Loses'; });
    const blocked = await dev2.ARSCloud.pushFarm('farm-1', dev2.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(blocked.success, false);

    const c = blocked.conflicts[0];
    dev2.ARSCloud.resolveConflict('farm-1', c, 'remote');
    assert.equal(dev2.ARSCloud.hasDirtyChanges('farm-1'), false, 'conflict dirty flag dropped');
    const pull = await dev2.ARSCloud.pullFarm('farm-1');
    assert.equal(pull.success, true);
    assert.equal(dev2.window.DB['farm-1'].sows.find(s => s.id === 'S-501').name, 'Cloud-Wins');
  });

  test('[FIX C3] offline delete is queued, never re-uploaded, and flushes when online', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    db.seedRow('farm-1', 'reminder', 'REM-1', { id: 'REM-1', title: 'Doomed reminder', _ars_cloud_local_id: 'REM-1' });
    const dev = loadDevice(db, 'dev1');
    await signIn(dev, email, password);
    await activateFarm(dev);

    // go offline: the app's own fetch fails (network drop)
    const realFetch = dev.fetch;
    dev.fetch = async () => { throw new Error('network unavailable'); };
    const del = await dev.ARSCloud.deleteAppRecord('farm-1', 'reminder', 'REM-1');
    assert.equal(del.queued, true, 'delete queued instead of lost');
    assert.equal(db.rowCount('farm-1'), 1, 'cloud still has the row (offline)');

    // back online: a push attempt flushes the queue before uploading
    dev.fetch = realFetch;
    const push = await dev.ARSCloud.pushFarm('farm-1', dev.window.DB['farm-1'], { dirtyOnly: true });
    assert.equal(push.success, true, push.reason || '');
    assert.equal(db.rowCount('farm-1'), 0, 'queued delete flushed to cloud');
    assert.equal(dev.ARSCloud.pendingDeletesForFarm('farm-1').length, 0, 'queue drained');
  });

  test('[FIX C3] batch delete queues each id when the RPC is unreachable', async () => {
    const db = new FakeSupabase();
    const { email, password } = makeFarm(db);
    db.seedRow('farm-1', 'sow', 'S-600', { id: 'S-600', name: 'A', _ars_cloud_local_id: 'S-600' });
    db.seedRow('farm-1', 'sow', 'S-601', { id: 'S-601', name: 'B', _ars_cloud_local_id: 'S-601' });
    const dev = loadDevice(db, 'dev1');
    await signIn(dev, email, password);
    await activateFarm(dev);
    const realFetch = dev.fetch;
    dev.fetch = async () => { throw new Error('offline'); };
    const res = await dev.ARSCloud.deleteAppRecordsBatch('farm-1', 'sow', ['S-600', 'S-601']);
    assert.equal(res.queued, true);
    assert.equal(dev.ARSCloud.pendingDeletesForFarm('farm-1').length, 2);
    dev.fetch = realFetch;
    const flush = await dev.ARSCloud.flushPendingDeletes('farm-1');
    assert.equal(flush.deleted, 2);
    assert.equal(db.rowCount('farm-1'), 0);
  });
});
