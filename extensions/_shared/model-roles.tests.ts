import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeModels } from "./model-roles.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const models = [{provider:"openrouter",id:"vendor/model:free"},{provider:"openrouter",id:"vendor/model"},{provider:"other",id:"literal:unknown"},{provider:"other",id:"literal:high"},{provider:"other",id:"literal"}];
test("absent settings scope allows all; malformed explicit scopes allow none and warn", () => {
 const dir=mkdtempSync(join(tmpdir(),"pi-scope-settings-")),old=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 try {
  assert.deepEqual(scopeModels(models),models);
  for(const text of ['{"enabledModels":null}','{"enabledModels":["openrouter/vendor/model:free",null]}','{"enabledModels":']) {
   writeFileSync(join(dir,"settings.json"),text);const unmatched:string[]=[];
   assert.deepEqual(scopeModels(models,undefined,p=>unmatched.push(p)),[]);
   assert.equal(unmatched.length,1);
  }
 } finally {if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;rmSync(dir,{recursive:true,force:true});}
});
test("literal free IDs never match paid sibling", () => assert.deepEqual(scopeModels(models,["openrouter/vendor/model:free"]), [models[0]]));
test("unmatched free scope never widens", () => assert.deepEqual(scopeModels(models,["openrouter/stale:free"]), []));
test("unknown colon suffix is literal", () => assert.deepEqual(scopeModels(models,["literal:unknown"]), [models[2]]));
test("literal thinking-like ID wins before stripping a suffix", () => assert.deepEqual(scopeModels(models,["other/literal:high"]), [models[3]]));
test("validated thinking suffix on free ID preserves free identity", () => assert.deepEqual(scopeModels(models,["openrouter/vendor/model:free:high"]), [models[0]]));
test("free globs remain free-only", () => assert.deepEqual(scopeModels(models,["openrouter/*:free"]), [models[0]]));
test("empty scope explicitly selects nothing", () => assert.deepEqual(scopeModels(models,[]), []));
test("unmatched patterns are reported individually even when another matches", () => { const unmatched:string[]=[];assert.deepEqual(scopeModels(models,["missing:free","openrouter/vendor/model:free"],p=>unmatched.push(p)),[models[0]]);assert.deepEqual(unmatched,["missing:free"]); });
test("duplicate and thinking globs retain order", () => assert.deepEqual(scopeModels(models,["openrouter/*:high", "openrouter/vendor/model"]), models.slice(0,2)));
