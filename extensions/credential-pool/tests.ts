import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";
const dir = mkdtempSync(join(tmpdir(), "pi-pool-test-"));
mkdirSync(join(dir,"credential-pool"));
process.on("exit", () => rmSync(dir,{recursive:true,force:true}));
const jwt = `e30.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"synthetic-account"}})).toString("base64url")}.signature`;
async function setup(keys: any[], response: () => Promise<Response>) {
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch, oldError = console.error;
 process.env.PI_CODING_AGENT_DIR = dir;
 const registrations: any[] = [], notices: string[] = [], logs: string[] = [], handlers = new Map<string, any>(), commands = new Map<string, any>();
 globalThis.fetch = response; console.error = (...args: any[]) => logs.push(args.join(" "));
 writeFileSync(join(dir,"credential-pool","pools.json"),JSON.stringify({pools:{"openai-codex":{type:"oauth",keys}}}));
 const pi: any = { registerProvider: (...args: any[]) => registrations.push(args), on: (name: string, fn: any) => handlers.set(name,fn), registerCommand: (name: string, command: any) => commands.set(name,command) };
 const ctx: any = {model:{provider:"openai-codex"},modelRegistry:{getProvider: () => undefined},ui:{notify:(s:string)=>notices.push(s),setStatus:()=>{}}};
 try { await extension(pi); } catch(e) { restore(); throw e; }
 function restore() { if(oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldDir; globalThis.fetch=oldFetch; console.error=oldError; }
 return {registrations,notices,logs,ctx,handlers,commands,restore};
}
const key = (expires = Date.now()-1000) => ({access:jwt,refresh:"synthetic-refresh-secret",expires});
for (const status of [200,400]) {
 test(`OAuth ${status} malformed response logs no token fields or values`,async()=>{const s=await setup([key()],async()=>new Response(JSON.stringify({access_token:"synthetic-access-secret",refresh_token:"synthetic-refresh-secret",error:"synthetic-error-secret"}),{status}));try{assert.ok(s.logs.length>0);assert.doesNotMatch(s.logs.join(" "),/synthetic-(?:access|refresh|error)-secret|access_token|refresh_token/);assert.equal(s.registrations.length,0);}finally{s.restore();}});
}
test("expired credentials with failed refresh are never registered",async()=>{const s=await setup([key(),key()],async()=>new Response("unavailable",{status:500}));try{assert.equal(s.registrations.length,0);await s.handlers.get("session_start")({},s.ctx);assert.match(s.notices.join(" "),/refresh failed|unavailable/);}finally{s.restore();}});
test("rotation and reset never register an expired unrefreshable fallback",async()=>{const s=await setup([key(Date.now()+60000),key()],async()=>new Response("unavailable",{status:500}));try{assert.equal(s.registrations.length,1);s.registrations.length=0;await s.handlers.get("after_provider_response")({status:401,headers:{}},s.ctx);assert.equal(s.registrations.length,0);await s.commands.get("pool-reset").handler("",s.ctx);assert.equal(s.registrations.length,0);}finally{s.restore();}});
test("pool diagnostics contain no key fragments",async()=>{const s=await setup([key(Date.now()+60000)],async()=>new Response("",{status:500}));try{await s.commands.get("pool").handler("",s.ctx);assert.doesNotMatch(s.notices.join(" "),/e30\.|signature|synthetic-refresh/);}finally{s.restore();}});
test("invalid refresh expiry is rejected",async()=>{for(const expires_in of [0,-1,1,Number.MAX_VALUE,"3600"]){const s=await setup([key()],async()=>new Response(JSON.stringify({access_token:jwt,refresh_token:"synthetic-new-refresh",expires_in})));try{assert.equal(s.registrations.length,0);}finally{s.restore();}}});
test("successful refresh registers only the new token",async()=>{const s=await setup([key()],async()=>new Response(JSON.stringify({access_token:jwt,refresh_token:"synthetic-new-refresh",expires_in:3600})));try{assert.equal(s.registrations.length,1);assert.equal(s.registrations[0][1].apiKey,jwt);}finally{s.restore();}});
test("fetch exceptions are not logged verbatim",async()=>{const s=await setup([key()],async()=>{throw new Error("refresh_token=synthetic-refresh-secret");});try{assert.doesNotMatch(s.logs.join(" "),/synthetic-refresh-secret|refresh_token/);}finally{s.restore();}});
test("native availability and request resolution fail closed after expiry",async()=>{
 let calls=0;const s=await setup([key(Date.now()+60000)],async()=>{calls++;return new Response("unavailable",{status:500});});
 const now=Date.now;
 try {
  s.ctx.modelRegistry.getProvider=()=>({id:"openai-codex",auth:{apiKey:{name:"old",resolve:async()=>({auth:{apiKey:"synthetic-old"}})}}});
  await s.handlers.get("session_start")({},s.ctx);
  const native=s.registrations.at(-1)![0];
  assert.ok(await native.auth.apiKey.check({}));assert.equal(calls,0);
  Date.now=()=>now()+120000;
  assert.equal(await native.auth.apiKey.check({}),undefined);assert.equal(calls,0,"selection must not refresh");
  await assert.rejects(native.auth.apiKey.resolve({signal:new AbortController().signal}),/unavailable/);
  assert.ok(calls>0);
  const before=s.registrations.length;
  await s.handlers.get("after_provider_response")({status:401,headers:{}},s.ctx);
  await s.commands.get("pool-reset").handler("",s.ctx);
  assert.equal(s.registrations.length,before,"events/reset must never replace the native guard with a literal key");
 } finally {Date.now=now;s.restore();}
});
test("malformed pool config parser does not echo credentials",async()=>{
 const oldDir=process.env.PI_CODING_AGENT_DIR,oldError=console.error;const logs:string[]=[];
 process.env.PI_CODING_AGENT_DIR=dir;console.error=(...args:any[])=>logs.push(args.join(" "));
 writeFileSync(join(dir,"credential-pool","pools.json"),'{"access":"synthetic-secret",');
 try {await extension({} as any);assert.doesNotMatch(logs.join(" "),/synthetic-secret/);}finally{console.error=oldError;if(oldDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldDir;}
});
