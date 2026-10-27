import assert from "node:assert/strict";
import { test } from "node:test";
import { supportsStockSdk } from "./node-version.ts";
for (const [version, expected] of [["20.19.5",false],["22.0.0",false],["22.18.0",false],["22.19.0",true],["22.20.0",true],["23.0.0",true],["24.21.0",true],["invalid",false]] as const) {
 test(`stock SDK runtime gate: ${version}`, () => assert.equal(supportsStockSdk(version),expected));
}
