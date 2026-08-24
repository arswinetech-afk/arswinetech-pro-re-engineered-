# ARSwineTech Pro — QA / Validation Harness

Executes the **real** app code (not re-implementations) against seeded farms and a
fake Supabase server to validate functions, arithmetic, algorithms and the
multi-device cloud sync engine.

## Run

```bash
cd qa
npm install            # jsdom (dev dependency only)
cd ..
npm test --prefix qa    # or:
node --test qa/tests/sync.test.mjs
node --test qa/tests/*.test.mjs
```

`qa/package.json` is a private QA package; `qa/node_modules` is ignored and not
part of the app.

## What is covered

| File | Validates |
|---|---|
| `tests/sync.test.mjs` | Real `client.js` in two isolated VM "devices" against one shared fake Supabase: baseline→edit→push→pull round trip, stale-device conflict blocking, `allowDirty` discard escape + recovery snapshot, delete-then-pull (no resurrection), feed upsert single-row, legacy local-id stability, synthetic id uniqueness, baseline gate, session refresh. |
| `tests/logic.test.mjs` | Real `app.js` + `piglet-ledger.js` + `reservations.js` + `financial-statements.js` in jsdom: date arithmetic (`isoOff`, `days`), sow `status()` day-33 rule, feed-forecast demand, ledger pool/available arithmetic, reservation picker math, genderless mortality, deposit recognition. |

## Utility

* `build-deploy-layout.sh` — creates a deployable directory layout
  (`js/`, `css/`, `supabase/`, `assets/`, `icons/`) from the flat repo files.
  The committed `index.html` and `sw.js` reference these sub-directories, but the
  repository currently stores every file at the root — the app will not boot
  until either this layout is used on the host or the files are moved.
```
