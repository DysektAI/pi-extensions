# Development

## Sources of truth

| Concern | Source |
|---------|--------|
| Public extensions in this package | **this repo** |
| Your Pi profile (settings, models, brand provider) | agent kit / `~/.pi/agent` |
| Personal/private extensions (e.g. workers, Orca) | keep only under `~/.pi/agent/extensions` or a private package |

## Safe local install

From a machine where this checkout is the intended runtime package:

```bash
pi install C:\Users\You\Documents\Github\pi-extensions
pi list
```

Local path packages are referenced from settings without copying files, so edits
here apply on next Pi start or `/reload` (for auto-discovered package paths).

## Avoid duplicate loading

If the same extension exists as:

1. a file under `~/.pi/agent/extensions/foo.ts`, **and**
2. this package,

Pi may load both. After installing this package, remove or rename the **managed
public** loose copies under `~/.pi` only after verifying load order. Keep personal
directories (`devin-worker`, `orca-*`, etc.).

## Splitting `/config` and recap

- `extensions/config.ts` — command + role pickers + registry menu
- `extensions/session-recap.ts` — recap footer only; registers `recaps` setting
- `_shared/config-settings.ts` — `registerConfigSetting` API
- `_shared/model-roles.ts` — role storage helpers

Other extensions should register settings rather than re-registering `/config`.

## Tests

Pure-helper unit tests run with the Node test runner via `tsx` — no live Pi
runtime or API keys needed:

```bash
npm test
```

Test files live next to the code they cover as `extensions/<name>/tests.ts` and
must only import from dependency-free modules (e.g. `pure.ts`, `client.ts`),
never from `@earendil-works/*`. When you add a new test file, append it to the
`test` script in `package.json` — CI (`.github/workflows/ci.yml`) runs
`npm run verify` on every push to `main` and every PR, on Ubuntu, Windows, and
macOS across Node 20 and 22.

## Secrets

No shipped extension may contain a live credential, trial key, or fallback token.
`typesafe` is the reference pattern: a machine-private `~/.pi/agent/auth.json`
entry (env var as fallback), no network call when unconfigured, and
`TYPESAFE_AUTO` opt-in for anything that transmits prompt text.

## Releases

Bump `package.json` version, tag `vX.Y.Z`, and pin installs with `@vX.Y.Z`.
Pinned git refs are not moved by `pi update --extensions`; reinstall with the
new ref to upgrade intentionally.
