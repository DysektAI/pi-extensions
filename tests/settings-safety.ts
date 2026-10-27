import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SettingsManager} from "@earendil-works/pi-coding-agent";
import warningExtension from "../extensions/default-model-warning/index.ts";
import {readOnlySettingsStorage} from "../extensions/default-model-warning/pure.ts";
const dir=mkdtempSync(join(tmpdir(),"pi-settings-sdk-")),cwd=join(dir,"work");
mkdirSync(join(cwd,".pi"),{recursive:true});
process.on("exit",()=>rmSync(dir,{recursive:true,force:true}));
test("real stock SettingsManager honors BOM, nested merge, and project trust without writes",()=>{
 const global='\uFEFF{"defaultProvider":"azure","defaultModel":"gpt-6.1-sol","compaction":{"enabled":true,"keepRecentTokens":100}}';
 writeFileSync(join(dir,"settings.json"),global);
 writeFileSync(join(cwd,".pi","settings.json"),'{"defaultModel":"project-model","compaction":{"keepRecentTokens":200}}');
 const trusted=SettingsManager.fromStorage(readOnlySettingsStorage(cwd,dir),{projectTrusted:true});
 assert.equal(trusted.getDefaultProvider(),"azure");assert.equal(trusted.getDefaultModel(),"project-model");
 assert.deepEqual(trusted.getCompactionSettings(),{enabled:true,reserveTokens:16384,keepRecentTokens:200});
 assert.deepEqual(trusted.drainErrors(),[]);
 const untrusted=SettingsManager.fromStorage(readOnlySettingsStorage(cwd,dir),{projectTrusted:false});
 assert.equal(untrusted.getDefaultModel(),"gpt-6.1-sol");assert.equal(readFileSync(join(dir,"settings.json"),"utf8"),global);
});
test("real stock SettingsManager records malformed settings instead of inventing defaults",()=>{
 writeFileSync(join(dir,"settings.json"),'{"token":"synthetic-secret",');
 const manager=SettingsManager.fromStorage(readOnlySettingsStorage(cwd,dir),{projectTrusted:false});
 assert.equal(manager.drainErrors().length,1);assert.equal(manager.getDefaultModel(),undefined);
});
test("new extension registers only the stock session_start observer",()=>{
 const registrations:string[]=[];
 warningExtension({on:(event:string)=>{registrations.push(event);return ()=>{};}} as any);
 assert.deepEqual(registrations,["session_start"]);
});
