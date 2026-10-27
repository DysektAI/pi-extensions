import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "pi-auto-update-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const { default: extension } = await import("../auto-update.ts");
if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = previous;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
function setup(result: any) {
 const commands = new Map<string, any>(), handlers = new Map<string, any>();
 const notices: Array<{message: string; level: string}> = [];
 const ctx: any = { ui: { notify: (message: string, level: string) => notices.push({message, level}) } };
 extension({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, command: any) => commands.set(name, command), exec: async () => { if (result instanceof Error) throw result; return result; } } as any);
 return { ctx, notices, handlers, run: (arg = "") => commands.get("auto-update").handler(arg, ctx) };
}
for (const [name, result] of Object.entries({ nonzero: {code: 1, killed: false, stdout: ""}, partial: {code: 2, killed: false, stdout: "Updated one package"}, timeout: {code: 0, killed: true, stdout: "Updated"}, signal: {code: 0, killed: false, signal: "SIGTERM"}, missingCode: {stdout: ""} })) {
 test(`update reports ${name} as failure`, async () => { const s = setup(result); await s.run(); assert.equal(s.notices.at(-1)?.level, "warning"); assert.match(s.notices.at(-1)!.message, /failed/i); });
}
test("aborted signal marks a zero-exit process as failure", async () => { const s=setup({code:0,killed:false,stdout:"Updated"});const controller=new AbortController();controller.abort();s.ctx.signal=controller.signal;await s.run();assert.equal(s.notices.at(-1)?.level,"warning"); });
test("cancellation and thrown errors never expose process output", async () => { const s = setup(new Error("access_token=synthetic-secret")); await s.run(); assert.equal(s.notices.at(-1)?.level, "warning"); assert.doesNotMatch(s.notices.at(-1)!.message, /synthetic-secret/); });
for (const [output, expected] of [["Already up to date", /already up to date/], ["Updated package", /restart pi/]] as const) {
 test(`successful update: ${output}`, async () => { const s = setup({code: 0, killed: false, stdout: output}); await s.run(); assert.match(s.notices.at(-1)!.message, expected); });
}
test("malformed settings remain byte-identical", async () => { const text = '{"keep": "user",'; writeFileSync(join(dir, "settings.json"), text); const s = setup({}); await s.run("on"); assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), text); assert.equal(s.notices.at(-1)?.level, "warning"); });
test("non-object settings are rejected", async () => { for (const text of ["null", "[]", '"string"']) { writeFileSync(join(dir, "settings.json"), text); await setup({}).run("off"); assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), text); } });
test("toggles preserve existing and BOM-prefixed fields", async () => { writeFileSync(join(dir, "settings.json"), '\uFEFF{"keep": {"user": true}}'); await setup({}).run("on"); assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {keep:{user:true}, autoUpdateExtensions:true}); });
test("stock-compatible lock serializes a competing writer and two toggles", async () => {
 const file = join(dir,"settings.json"); writeFileSync(file,'{"keep":true}');
 const release = await lockfile.lock(file,{realpath:false});
 const s=setup({}); let finished=false;
 const pending=s.run("on").then(()=>{finished=true;});
 await new Promise(r=>setTimeout(r,40));
 try { assert.equal(finished,false,"toggle must wait for stock settings.json.lock"); writeFileSync(file,'{"keep":true,"competing":42}'); } finally { await release(); }
 await pending;
 await Promise.all([s.run("off"),s.run("on")]);
 assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),{keep:true,competing:42,autoUpdateExtensions:true});
});
test("in-process toggles retain invocation order despite delayed lock acquisition", async (t) => {
 const file=join(dir,"settings.json");writeFileSync(file,'{"keep":true}');
 const realLock=lockfile.lock;let calls=0;
 t.mock.method(lockfile,"lock",async (file:string,options:any)=>{
  if(calls++===0)await new Promise(r=>setTimeout(r,40));
  return realLock(file,options);
 });
 const s=setup({});await Promise.all([s.run("off"),s.run("on")]);
 assert.equal(JSON.parse(readFileSync(file,"utf8")).autoUpdateExtensions,true);
});
test("cross-process toggles preserve a concurrent stock-compatible writer",async()=>{
 const file=join(dir,"settings.json");writeFileSync(file,'{"keep":true}');
 const child=spawn(process.execPath,["--input-type=module","-e",`import lockfile from 'proper-lockfile'; import {readFileSync,writeFileSync} from 'node:fs'; const release=await lockfile.lock(process.argv[1],{realpath:false}); const s=JSON.parse(readFileSync(process.argv[1],'utf8')); process.stdout.write('locked\\n'); await new Promise(r=>setTimeout(r,120)); s.child=42;writeFileSync(process.argv[1],JSON.stringify(s));await release();`,file],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});
 const exited=new Promise<void>((resolve,reject)=>{child.on("error",reject);child.on("exit",code=>code===0?resolve():reject(new Error("Synthetic writer failed")));});
 await new Promise<void>((resolve,reject)=>{child.stdout.once("data",()=>resolve());child.once("error",reject);child.once("exit",code=>{if(code!==0)reject(new Error("Writer failed before lock"));});});
 await setup({}).run("on");await exited;
 assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),{keep:true,child:42,autoUpdateExtensions:true});
});
