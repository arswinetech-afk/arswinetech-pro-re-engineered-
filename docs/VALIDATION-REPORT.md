# ARSwineTech Pro — Deep-Dive Validation Report

**Scope:** complete inspection of functions, logic, arithmetic, algorithms and
the multi-device cloud-sync engine for the re-engineered PWA (39 files,
~38,600 lines of JS).
**Method:** static review of all modules + syntax checks (`node --check` on every
file, all pass) + automated tests that execute the **real production code**
(`client.js`, `app.js`, `piglet-ledger.js`, `reservations.js`,
`financial-statements.js`) against seeded farms and a fake Supabase.
**Result:** 19/19 QA tests pass — the tests document both the *working*
behaviour and the defects below (each defect is reproducible by the matching
test or is directly evidenced in the cited code).

---

## 1. Summary verdict

| Area | Verdict |
|---|---|
| Boot / deployment | ❌ **Broken as committed** — asset paths do not match the repo layout |
| Auth & session layer | ✅ Sound (published-key only, RLS-dependent, offline mode honest) |
| Multi-device sync engine | ✅ Core safety rails work (verified) — but **2 deadlocks/data-loss paths** |
| Herd arithmetic (sows/piglets) | ⚠️ 2 date bugs with wrong output; several cross-module count mismatches |
| Inventory / money arithmetic | ⚠️ Semen & piglet money math is careful; several validation gaps & 1 dedupe heuristic |
| Genetics (inbreeding) | ✅ Wright algorithm correct — ⚠️ but one breeding path corrupts pedigree |
| Reminders / forecast | ⚠️ interval drift; feed-plan limitations |
| Security (client-side) | ⚠️ multiple DOM-injection (XSS) spots; no conflict-resolution UI |

---

## 2. Critical findings

### C1. The app cannot boot from this repository — asset path mismatch  🔴
`index.html` and `sw.js` reference sub-directories, but the upload stored every
file at the repository root:

| Referenced path | In repo? |
|---|---|
| `css/app.css` | ❌ (file is `app.css`) |
| `js/app.js` (and 40+ `js/*.js`) | ❌ |
| `supabase/config.js`, `supabase/client.js` | ❌ |
| `assets/arswinetech-logo.png`, `assets/semen-bottle.png` | ❌ |
| `icons/icon-192.png`, `icons/icon-512.png` | ❌ |

Consequences: 100% of CSS/JS 404 → blank page; `sw.js` `APP_SHELL` cache.addAll
fails → **service worker never installs → no offline/PWA**; manifest icons fail
→ install prompt won't qualify.

**Fix provided:** `qa/build-deploy-layout.sh` builds the correct deploy tree
(`js/`, `css/`, `supabase/`, `assets/`, `icons/`). The permanent fix is to
restructure the repo (index.html/sw.js already expect that layout).

### C2. Conflict deadlock with a silent-discard "escape"  🔴
Two devices editing the same row is handled *correctly* (stale write blocked,
local value preserved, recovery snapshot kept — see §3), but there is **no
conflict-review UI anywhere**:
- `cloud-sync.js` sets the indicator to `error / "Review needed"` and *stops*
  retrying (`cloud-sync.js:150-160`).
- Background pull is blocked while dirty rows exist
  (`client.js:772-776`), and auto-push is blocked by the conflict forever.
- The only escape is an `allowDirty: true` pull, which is invoked at
  sign-in/farm-switch (`app.js:2881`) — it **replaces the local bucket and
  clears all dirty flags** (`client.js:870-874`), i.e. the farmer's edit is
  silently discarded (a recovery snapshot is saved first, so it is not
  unrecoverable, but the user is never told).

**Verified by test** `allowDirty pull replaces bucket but preserves recovery snapshot`.
**Fix:** add a "conflict review" panel (see roadmap P1-2) that shows remote vs
local values and lets the user choose keep-locally/keep-remote/merge.

### C3. Offline deletions are fire-and-forget — deleted rows can resurrect  🔴
Deleting a record calls `ARSCloud.deleteAppRecord(...).catch(() => {})`
**without await / without a retry queue**:
- `reservations.js:1448-1449`, `semen-sales.js:2654-2658, 3709-3710`,
  `lineage.js:546-547`, `boar-registry.js:149-150`, `reminder-engine.js:343-344`,
  `vaccination-center.js:929, 947-948, 1058-1059`.

If the device is offline (or the call flickers), the cloud row survives; the
next pull from *any* device restores the "permanently deleted" record. The
`F().deleted_ids` tombstones used by the UI are **not synced** (they are not in
`client.js` `entityMap`, so `buildRows` never uploads them), and `ensureResellerData`
only filters locally.

**Fix:** queue deletes (dirty-tombstone rows), or await + verify them like the
save path, and make `verifyFarmSave` include tombstone keys.

---

## 3. What IS working correctly (verified by executing the real code)

| # | Behaviour | Evidence |
|---|---|---|
| 1 | Pull → local edit → push → second device sees the row | sync test 1 |
| 2 | Stale device cannot overwrite newer remote row; conflict reported; local edit preserved as dirty | sync test 2 |
| 3 | Cloud delete then pull does **not** resurrect | sync test 4 |
| 4 | Feed inventory stays a single balance row per type on upsert | sync test 5 |
| 5 | Legacy rows keep a stable `_ars_cloud_local_id` from the cloud — no index drift | sync test 6 |
| 6 | New rows without business ids get **unique** synthetic ids per device (no key collision) | sync test 7 |
| 7 | Push is blocked before a verified cloud baseline (safety gate) | sync test 8 |
| 8 | Session refresh + re-validation works | sync test 9 |
| 9 | Delete-then-pull across devices keeps herd counts consistent (release-style sold rows) | logic test: `counts(): release-style …` |
| 10 | Financial summaries: held deposits excluded from gross sales; receivables = gross − collected; mortality `max()` prevents double-counting | logic test + `financial-statements.js:87-118,144-148` |
| 11 | Wright's inbreeding coefficient formula is correct: `Σ 0.5^(n₁+n₂+1)·(1+F_A)`, and parent/offspring (25%), full-sib (25%), half-sib (12.5%), grandparent (12.5%), uncle/aunt (6.25%) blocks match the standard values | `pedigree.js:127-171` |
| 12 | Farrowing due date = insemination + 114 days (both `app.js` `dueThisWeek` and `drilldown.js` agree) | reviewed |
| 13 | Money math in semen POS is guarded (`Math.max(0,…)` on every balance), returns restore stock, payments capped at balance, FIFO allocation across invoices | `semen-sales.js` reviewed |

---

## 4. High-severity logic/arithmetic defects

### H1. Production forecast weaning & market dates double-count the batch age 🟠
`app.js:1344` and `app.js:1421`:
```js
const weanDate = isoOff(days(b.birth) + 28);   // should be addDaysToDate(b.birth, 28)
const mktDate = isoOff(days(b.birth) + 160);   // should be addDaysToDate(b.birth, 160)
```
`isoOff(n)` = *today + n*, so weaning is today + age + 28 instead of birth + 28
(error = 2× age).

**Verified numerically** (batch born 2026-06-01, today 2026-08-24, age 84):
- Wean date shown: **2026-12-14** → correct: **2026-06-29**
- Market date shown: **2027-04-25** → correct: **2026-11-08**

Impact: "Scheduled Weaning" and "Market Readiness" events are pushed months
into the future, so alarms ("Ready to Wean Now") never fire; KPIs mislead.
Covered by logic tests.

### H2. One breeding path overwrites the sow's biological sire with the service boar 🟠
`sow-tools.js:206-208` (`saveInsemination`, used by Sow Profile → Breed/inseminate):
```js
sow.sire = data.boar;        // overwrites the FATHER with the service boar
sow.sireRef = boar?.id || null;
```
The newer, linked breeding flow (`lineage.js`) explicitly does the opposite:
`/* … Never overwrite biological sire/dam with a breeding semen source. */`
and stores `sow.lastSemenBoarName / lastSemenBoarId` (`lineage.js:308-309`).

Impact: `pedigree.js parents(sow)` then reports the *service boar* as the sow's
father. After one insemination via this path, the genetics engine (`compatibility()`)
can falsely block or flag crosses (parent-offspring / inbreeding) and the
pedigree tree shows wrong parentage. Two UI entry points behave differently.

### H3. Reservation picker availability ignores sold/released heads 🟠
`reservations.js:26-44` `available(b)`:
```js
const alive = (g === "male" ? m : f) - sum("mortality", g);   // sold NOT subtracted
const assigned = sum("breeder", g) + sum("fattener", g) + sum("farm_use", g);
return Math.max(0, alive - assigned - unassignedRes);
```
- It shows the **unassigned** count, but reservations are actually taken from an
  **assignable pool** (`allocationAvailable()`), so displayed and validated
  numbers are different quantities.
- Sold heads are not subtracted at all.

**Verified test** (10M: 5 sold from fattener, 5 breeder-allocated):
ledger says **0 available**, picker math says **5 available**.

### H4. Floating-reservation partial allocation can lead to over-selling on release 🟠
`reservations.js:755`:
```js
const allocateQty = Math.min(needed, Math.max(1, availableHeads));
```
When fewer heads are available than requested (user confirms the partial
allocation), only `allocateQty` is booked into the piglet ledger, but
`r.quantity` is **not reduced** — the release flow later books
`r.quantity` as sold (`saveRelease`, ~line 1175), i.e. more heads than were
ever reserved. Ledger caps keep `alive` ≥ 0, but the arithmetic over-states
sales and can allocate the same head twice.

### H5. Legacy source-less sold rows zero the breeder pool and inflate "available" 🟠
`piglet-ledger.js:137-141` `sourceSold()` treats *any* source-less `sold` row as
a breeder-pool sale (`!x.source && src === "breeder"`), then
`poolBreederM = assigned − sold` (`:158`) → pool = 0 while
`availableM = alive − 0` **re-shows the same 5 breeders as unassigned**.

**Verified test** `legacy source-less sold rows…` with the *real* module:
`breederAssigned 5`, `breeder 0`, `availableM 5`. Modern releases always set
`source` so this only affects legacy rows — but those rows are exactly the ones
a long-lived farm will have.

---

## 5. Medium-severity defects

| # | Finding | Location |
|---|---|---|
| M1 | **Inconsistent "alive" definitions across screens.** Vaccination prep, medicine dosing and performance ADG use `born − mortality` (sold ignored); dashboard/ledger/fattener/production use `born − mortality − sold`. Same batch shows different headcounts → over-prepared vaccine doses / wrong ADG context | `vaccination-center.js:63-64`, `medicine-inventory.js:515-516`, `batch-performance.js:32` vs `piglet-ledger.js:119-121`, `fattener-center.js:42`, `production-control.js:592-601` |
| M2 | **UTC "today" leaks into date pickers.** `new Date().toISOString().slice(0,10)` (65 uses) is the UTC date — in the Philippines (UTC+8) between 00:00–08:00 the pickers pre-fill **yesterday** (reminders, heat, farrow, wean, mortality, sale dates). `app.js:53` does the same for `TODAY`, so gestation-day/"overdue" labels also lag up to 8h. Pre-fill with a local `YYYY-MM-DD` helper (the file already has `localDateTimeValue()` for the same reason) | e.g. `sow-tools.js:83,208`, `reminder-engine.js:191`, `piglet-ledger.js:330`, `reservations.js` |
| M3 | **`days()` uses `Math.round`, `drilldown realDays()` uses `Math.floor`** — after 12:00 the same sow can display as Day 85 (dashboard) vs Day 84 (drill-down); 114-day "overdue" decisions differ between views | `app.js:60` vs `drilldown.js:3` |
| M4 | **Deposit-recognition matcher can never match a released reservation.** `isCustomerDeposit` builds `hay = r.no + ' ' + r.id` and requires the TX description to contain *both*; release/saveReservation descriptions contain only `r.no`. Result: prepayments remain "customer deposits held" forever (balance sheet line sticky; cash flow still balances because the release sale books the full amount). Verified by test | `financial-statements.js:60-67`, `reservations.js:714-722` |
| M5 | **Interval reminders drift after a missed occurrence.** If a "every 12 h" reminder is dismissed 5 h late, the next trigger = now + 12 h (not anchor + k×12 h), so lateness accumulates each cycle. Same pattern applies to snoozes | `reminder-engine.js:114-122` |
| M6 | **Batch-transaction edit has no capacity validation.** `saveEditBatchTransaction` accepts any new qty/type; with the pool cap logic, pools can sum above alive and block further allocations while showing misleading "living pool" counts | `piglet-ledger.js:713-763` |
| M7 | **Genderless mortality rows count in the Mortality stat but do not reduce `alive`.** Ledger math only uses `mortM/mortF` | `piglet-ledger.js:96-119` |
| M8 | **Reseller pickup/return-replace validation gaps.** Pickup deducts `max(0, stock − qty)` without a `qty ≤ stock` check (can bill 50 bottles when 10 on hand; stock clamps at 0); return/replace stores `retQty` without an upper bound (only the HTML `max` attribute) and `repQty` is deducted without checking availability | `semen-sales.js:3275-3300, 3037-3060` |
| M9 | **Shared `deleted_ids` tombstone list.** Deleting a reservation pushes the *customer name* into the same list used by `ensureResellerData()` to hide resellers — a reseller with the same name disappears from the hub. Tombstones are also never uploaded (see C3) | `reservations.js:1431-1437`, `semen-sales.js:595-631, 3260-3290` |
| M10 | **`deleteUser`/`purgeTestAccounts` are local-store driven** for the user map while real membership is server RLS-driven; `users()`/`myUser()` can drift from Supabase (UI roles may display differently from enforced roles) | `app.js:2394-2570` |

---

## 6. Low-severity / hygiene

| # | Finding | Location |
|---|---|---|
| L1 | `register-sw (2).js` is an identical duplicate of `register-sw.js` — confusion risk & duplicate service-worker code | repo root |
| L2 | `const seeds = {...}` (~1.7 KB) is declared but never referenced — dead demo data with 2026 snapshot values that could mislead future maintainers | `app.js:129-283` |
| L3 | `window.save` wrapper in `cloud-sync.js` adds no behaviour (the real trigger is `save()` calling `scheduleAutoPush`) — fragile if `save()` changes | `cloud-sync.js:272-277` |
| L4 | DOM injection (XSS) spots: raw interpolations of user data into `innerHTML`/attributes — `openSowProfile` (`sow.name/id/breed`), `openPigletEditor` (`value="${v('id')}"`), vaccine names into `onclick="pickVaxSuggestion('${v}')"` (single quotes not escaped by `esc`), `compareImportedJSON` output. Farm data is trusted-ish, but a customer/contact field with `"`/`<` can break markup or execute inline handlers | `sow-tools.js:31-46`, `piglet-ledger.js:853-894`, `reservations.js:998-1020` |
| L5 | `cleanCloudTestRecords` uses `ilike.*verify*` string patterns in a PostgREST `or(...)` filter without URL-encoding — works in most hosts but brittle, and it can delete legitimate records whose names contain "test" | `client.js:920-924` |
| L6 | BLE GATT weight assumes fixed **0.005 kg resolution** for the standard Weight Measurement (0x2A98) and ignores the resolution/flags bits; ASCII stability regex marks `GS,` (gross/stable) frames as stable — verify against real scales | `ble-scale.js:164-176, 202-206` |
| L7 | BLE printer code path is large (~600 lines) and untestable in CI; `escPosFromLines` pushes bytes > 0xFF (non-ASCII) un-sanitized in one helper | `semen-sales.js` |

---

## 7. Test assets

```bash
cd qa && npm install && cd ..
node --test qa/tests/*.test.mjs        # 19 tests, all green
qa/build-deploy-layout.sh /tmp/dist    # fix for C1
```
