import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("Discord implementation is owned by pi-cord, not bundled twice", () => {
  for (const path of ["../extensions/discord.ts", "../extensions/_shared/discord-auth.ts", "../extensions/_shared/discord-auth.tests.ts"]) {
    assert.equal(existsSync(fileURLToPath(new URL(path, import.meta.url))), false, `${path} must stay in the standalone package`);
  }
});
