import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultModelCheck, readOnlySettingsStorage } from "./pure.ts";

const dir = mkdtempSync(join(tmpdir(),"pi-default-warning-")), cwd=join(dir,"work");
mkdirSync(join(cwd,".pi"),{recursive:true});
process.on("exit",()=>rmSync(dir,{recursive:true,force:true}));
function setup(global = '{"defaultProvider":"azure","defaultModel":"gpt-6.1-sol"}', project="{}") {
 writeFileSync(join(dir,"settings.json"),global); writeFileSync(join(cwd,".pi","settings.json"),project);
 const notices:string[]=[], reads:string[]=[];
 const check=createDefaultModelCheck(()=>dir,(storage,{projectTrusted})=>{
  const data:any={},errors:unknown[]=[];
  for(const scope of projectTrusted?["global","project"] as const:["global"] as const) {
   reads.push(scope);
   try { storage.withLock(scope,text=>{Object.assign(data,JSON.parse((text??"{}").replace(/^\uFEFF/,"")));return undefined;}); } catch(e) {errors.push(e);}
  }
  return {getDefaultProvider:()=>data.defaultProvider,getDefaultModel:()=>data.defaultModel,drainErrors:()=>errors};
 });
 const ctx:any={cwd,hasUI:true,model:{provider:"other",id:"alternate"},isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>"session-1"},ui:{notify:(s:string)=>notices.push(s)}};
 return {check,ctx,notices,reads};
}
test("mismatch names both models once per session, including new",()=>{const s=setup();s.check({reason:"startup"},s.ctx);s.check({reason:"startup"},s.ctx);assert.equal(s.notices.length,1);assert.match(s.notices[0],/other\/alternate.*azure\/gpt-6.1-sol/);s.ctx.sessionManager.getSessionId=()=>"session-2";s.check({reason:"new"},s.ctx);assert.equal(s.notices.length,2);});
test("match is silent; equal ID with different provider warns",()=>{const s=setup();s.ctx.model={provider:"azure",id:"gpt-6.1-sol"};s.check({reason:"startup"},s.ctx);assert.equal(s.notices.length,0);s.ctx.sessionManager.getSessionId=()=>"session-2";s.ctx.model.provider="other";s.check({reason:"new"},s.ctx);assert.equal(s.notices.length,1);});
test("resume/reload/fork do not even read settings",()=>{const s=setup();for(const reason of ["resume","reload","fork"])s.check({reason},s.ctx);assert.deepEqual(s.reads,[]);assert.deepEqual(s.notices,[]);});
test("missing defaults and no UI are silent",()=>{const s=setup("{}");s.check({reason:"startup"},s.ctx);assert.deepEqual(s.notices,[]);const t=setup();t.ctx.hasUI=false;t.check({reason:"startup"},t.ctx);assert.deepEqual(t.reads,[]);});
test("no active model warns rather than making a model call",()=>{const s=setup();delete s.ctx.model;s.check({reason:"startup"},s.ctx);assert.match(s.notices[0],/no active model.*azure\/gpt-6.1-sol/);});
test("trusted project defaults override global, untrusted project never read",()=>{const p='{"defaultProvider":"other","defaultModel":"alternate"}';const s=setup(undefined,p);s.check({reason:"startup"},s.ctx);assert.deepEqual(s.notices,[]);const t=setup(undefined,p);t.ctx.isProjectTrusted=()=>false;t.check({reason:"startup"},t.ctx);assert.deepEqual(t.reads,["global"]);assert.equal(t.notices.length,1);});
test("BOM supported and settings are byte-identical with no new lock files",()=>{const text='\uFEFF{"defaultProvider":"azure","defaultModel":"gpt-6.1-sol"}';const s=setup(text);const before=readdirSync(dir);s.check({reason:"startup"},s.ctx);assert.match(s.notices[0],/azure\/gpt-6.1-sol/);assert.equal(readFileSync(join(dir,"settings.json"),"utf8"),text);assert.deepEqual(readdirSync(dir),before);});
test("malformed/empty/non-object settings produce one sanitized warning",()=>{for(const text of ['{"access_token":"synthetic-secret",',"","null","[]"]){const s=setup(text);s.check({reason:"startup"},s.ctx);assert.equal(s.notices.length,1);assert.match(s.notices[0],/unavailable/);assert.doesNotMatch(s.notices[0],/synthetic-secret|access_token/);assert.equal(readFileSync(join(dir,"settings.json"),"utf8"),text);}});
test("read-only adapter rejects any returned write",()=>{setup();assert.throws(()=>readOnlySettingsStorage(cwd,dir).withLock("global",()=>"{}"),/cannot write/);});
