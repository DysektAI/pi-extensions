import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

test("SDK dependency override keeps reviewed Undici in the lock and installed graph", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.overrides?.["@earendil-works/pi-coding-agent@1.0.0"]?.undici, "8.12.2");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const resolutions = Object.entries(lock.packages as Record<string, { version?: string }>).filter(([name]) => name === "node_modules/undici" || name.endsWith("/node_modules/undici"));
  assert.ok(resolutions.length > 0, "The SDK must resolve a reviewed Undici dependency");
  for (const [, entry] of resolutions) assert.equal(entry.version, "8.12.2");
  const sdkRequire = createRequire(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
  assert.equal(sdkRequire("undici/package.json").version, "8.12.2");
});
