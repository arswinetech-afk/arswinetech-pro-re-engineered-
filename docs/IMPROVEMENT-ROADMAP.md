# ARSwineTech Pro — Improvement Suggestions & Rebuild Roadmap

Prioritised by risk-to-farmer-data vs effort. Each item cites the evidence in
`VALIDATION-REPORT.md`.

---

## P0 — Fix now (data-loss / broken deployment)

### 1. Fix the deploy layout (C1)
Use `qa/build-deploy-layout.sh`, or restructure the repo so `js/`, `css/`,
`supabase/`, `assets/`, `icons/` exist. Then bump `CACHE_NAME` in `sw.js` so old
clients pick up the new shell.

### 2. Add a conflict-review UI (C2)
The engine already reports `conflicts` — surface them:

```js
// cloud-sync.js — when conflicts arrive, open a review sheet instead of "Review needed"
function openConflictReview(fId, res) {
  const rows = (res.conflicts || []).map(c => {
    const local = window.DB?.[fId]?.[/* entity */]?.find(r => /* local_id */);
    return { key: c.local_id, entity: c.entity_type, remoteAt: c.remote_updated_at, local };
  });
  // modal: [Keep my local copy (force push)] [Use cloud version] [Export both to JSON]
}
```
Force-push should set the local baseline to the remote version first
(`cloudVersions.set(key,{updated_at: remoteAt})`) so the preflight stops flagging
it, then push — never silently discard.

### 3. Queue offline deletes (C3)
Add a `deleted_rows` map to `ARSCloud`:
```js
// client.js
dirtyDeletes: new Map(), // key -> {farm_id, entity_type, local_id, at}
async deleteAppRecord(farmId, entityType, localId) {
  const key = rowKey(farmId, entityType, localId);
  this.dirtyDeletes.set(key, { farm_id: farmId, entity_type: entityType, local_id: localId, at: Date.now() });
  saveLocalRecovery(...);
  return this.flushDeletes(farmId); // retried by the same auto-push loop
}
```
Include tombstone keys in `buildRows`/entityMap (or a new `_tombstones` row type)
so other devices converge.

### 4. Fix the two date-calculation bugs (H1)
```js
// app.js production():
const weanDate = addDaysToDate(b.birth, 28);   // was isoOff(days(b.birth)+28)
const mktDate = addDaysToDate(b.birth, 160);   // was isoOff(days(b.birth)+160)
```

### 5. Stop overwriting the sow's biological sire (H2)
```js
// sow-tools.js saveInsemination()
sow.lastSemenBoarName = data.boar;   // service boar — separate field
sow.lastSemenBoarId   = boar?.id || null;
// REMOVE: sow.sire = data.boar; sow.sireRef = boar?.id;
```
Add a one-time migration for affected sows: if `sireRef` points at a boar
created after the sow's birth and `lastSemenBoarId` is unset, copy to
`lastSemenBoarId` and restore `sire` from the oldest breedingRecord's boar name.

---

## P1 — High value, next sprint

### 6. One definition of "alive" (M1)
Create a single `herdCounts(batch, {excludeArchived})` util in `piglet-ledger.js`
and use it in vaccination, medicine, batch-performance, fattener, production.
Vaccination doses must use `alive` (born − mortality − sold).

### 7. Local-time date handling (M2/M3)
```js
const localToday = () => {                       // use everywhere instead of toISOString().slice(0,10)
  const d = new Date(); const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
};
```
And make `realDays()` use the same `days()` helper so dashboard/drill-down agree.

### 8. Reservation picker math (H3/H4)
* Show `allocationAvailable(b, source, gender)` per selected source (with a
  source selector in the picker), not raw `available()`.
* When a floating reservation is only partially allocatable, either split the
  reservation (keep remainder floating) or reduce `r.quantity` and keep the
  remainder as a new floating line — never leave `r.quantity` larger than the
  booked heads.

### 9. Legacy sold-row attribution (H5)
Remove the `!x.source && src === 'breeder'` fallback in `sourceSold()`; attribute
source-less sold rows to a neutral "legacy" bucket that subtracts from `alive`
but not from any pool:
```js
const legacySold = sumNoSource('sold');            // subtract from alive only
const poolX = Math.max(0, assignedX - mortX - soldX(withSource));
```

### 10. Sync protocol hardening (already good, make great)
* **Server-generated versions:** stop trusting client `updated_at` for conflict
  detection. Add `rev bigint` (or `updated_at default now()` with a trigger) and
  compare against the *server* value returned by preflight; client `updated_at`
  becomes display metadata only. This removes the slow-clock overwrite risk.
* **Tombstones for every entity** (soft-delete + `deleted_at`) so deletes
  replicate regardless of offline timing.
* **Backoff + jitter** on retries; exponential (5s → 60s) instead of fixed 15 s.
* **Throttle pull when the tab is hidden** (already done) and add `navigator.connection.saveData` awareness.

---

## P2 — Platform quality

### 11. Rebuild suggestions (the "recreate" path)
If re-created from scratch, keep the domain but modernise the shell:

| Today | Better |
|---|---|
| One `window.DB` JSON in localStorage (whole-farm re-write per save) | IndexedDB per-entity stores + schema versioning; sync worker (Web Worker) reads/writes without janking the UI |
| 40 global scripts, wrap/replace order dependencies | ES modules + a tiny bundler (Vite). TypeScript optional; at minimum `"use strict"` + explicit exports |
| Dirty-diff by deep JSON compare of the whole farm | Per-entity command log (event sourcing) — each mutation emits an event (`{id, entity, action, payload, rev}`); sync = event replication, conflict = per-event review |
| Client-deterministic dates | Single `Date`/timezone util (luxon/date-fns) — all arithmetic tested in UTC+8 |
| Hand-rolled money math | Integer centavos (₱ × 100) or a money lib; currency formatting only at the edge |
| Inline HTML template strings with injection risk | Template engine or DOM builders + an automatic `escape()` lint rule |
| `confirm()`-driven destructive flows | Undo stack + audit-log-first design |
| Feature flags by plan in client only | Server-side entitlement RLS/`rpc` checks; plan gating mirrored client-side for UX |
| BLE/ZXing in main thread | Web Worker for barcode decoding; BLE only on HTTPS+Android with feature detection UI |
| Single `app_records` JSONB table | (Optional) typed tables per entity with RLS by farm_id for queryability + backend validation/triggers (keep `app_records` only as the offline-compatible mirror) |

### 12. Observability & QA
* Synthetic device tests are already in `qa/` — add them to CI
  (`node --test qa/tests/*.test.mjs`).
* Add a boot smoke test (jsdom) that fails the build if any `<script>` or asset
  path 404s (the C1 bug would have been caught immediately).
* Log sync health (`__arsLastSuccessfulSyncAt`, conflict counts, dirty counts)
  to an `integration_event` for the farm dashboard.
* Add a "Sync console" (not admin-gated) showing dirty rows, last push/pull,
  conflict list, with a **force-push** and **export local** button.

### 13. Small wins
* Delete `register-sw (2).js`; remove dead `seeds` block or gate behind a debug
  query param; use `localDateTimeValue()`-style helpers everywhere; escape with a
  shared `esc` in every template (fix the 5+ raw interpolation sites); keep
  `esc` consistent (add `'` escaping); URL-encode the `cleanCloudTestRecords`
  filter; validate BLE weight resolution from the flags byte; unit-test
  `nextOccurrence` for skip-ahead semantics:
  ```js
  if (x <= now) {
    const k = Math.ceil((now - anchor) / ms);
    x = new Date(+anchor + k * ms);          // keeps the schedule anchored
  }
  ```

---

## Suggested order of implementation

1. P0-1 layout → P0-4 dates → P0-2 conflict UI → P0-3 delete queue → P0-5 sire fix
2. P1-6..9 (single source of truth for counts & dates)
3. P1-10 server-side versions + tombstones
4. P2 rebuild track (event-sourced sync, typed storage) alongside feature work

**Estimated impact:** the P0 set removes the only two silent data-loss paths and
the wrong-date/broken-deploy failures; the P1 set makes every headcount on every
screen agree with the ledger — the single most common source of farm-data doubt.
