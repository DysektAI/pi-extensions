import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

test("test setup documents stock SDK dependency installation, not a retired fork", () => {
  const setup = readFileSync(new URL("../extensions/config/tests.ts", import.meta.url), "utf8");
  assert.equal(setup.includes("pi-fork"), false, "No retired-fork setup reference");
  assert.equal(setup.includes("npm ci"), true, "Stock SDK install command documented");
});

test("SDK dependency override keeps reviewed Undici in the lock and installed graph", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.overrides?.["@earendil-works/pi-coding-agent@1.5.2"]?.undici, "8.12.3");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const resolutions = Object.entries(lock.packages as Record<string, { version?: string }>).filter(([name]) => name === "node_modules/undici" || name.endsWith("/node_modules/undici"));
  assert.ok(resolutions.length > 0, "The SDK must resolve a reviewed Undici dependency");
  for (const [, entry] of resolutions) assert.equal(entry.version, "8.12.3");
  const sdkRequire = createRequire(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));
  assert.equal(sdkRequire("undici/package.json").version, "8.12.3");
});

test("Pi SDK dependencies and transitive packages use the same reviewed release", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const sdk = Object.entries(manifest.devDependencies).filter(([name]) => name.startsWith("@earendil-works/pi-"));
  assert.ok(sdk.length > 0);
  for (const [, version] of sdk) assert.equal(version, "1.5.2");
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const packages = Object.entries(lock.packages as Record<string, { version?: string }>).filter(([name]) => /(?:^|\/)node_modules\/@earendil-works\/pi-/.test(name));
  for (const [name] of sdk) assert.equal(lock.packages[`node_modules/${name}`]?.version, "1.5.2", name);
  for (const [name, entry] of packages) assert.equal(entry.version, "1.5.2", name);
});
