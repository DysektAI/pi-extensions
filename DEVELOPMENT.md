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

## Releases

Bump `package.json` version, tag `vX.Y.Z`, and pin installs with `@vX.Y.Z`.
Pinned git refs are not moved by `pi update --extensions`; reinstall with the
new ref to upgrade intentionally.
