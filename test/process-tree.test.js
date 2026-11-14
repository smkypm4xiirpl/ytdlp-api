import test from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { readFile } from "node:fs/promises";
import { runManagedProcess } from "../src/services/managed-process.js";

function alive(pid) { try { process.kill(pid,0); return true; } catch (error) { return error.code === "EPERM"; } }
async function waitDead(pid) { for(let i=0;i<60;i++){if(!alive(pid))return; await new Promise(r=>setTimeout(r,50));} }

test("cancellation terminates fake parent and descendant process tree", async t=>{
 const controller=new AbortController(); let descendantPid;
 const parentCode="const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(c.pid)+'\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);";
 const run=runManagedProcess(execPath,["-e",parentCode],{signal:controller.signal,timeoutMs:10_000,maxStdoutBytes:100,onStdout:chunk=>{const n=Number(chunk.trim());if(Number.isInteger(n))descendantPid=n;}});
 t.after(()=>{if(descendantPid&&alive(descendantPid)){try{process.kill(descendantPid,"SIGKILL");}catch{}}});
 for(let i=0;i<40&&!descendantPid;i++) await new Promise(r=>setTimeout(r,25));
 assert.ok(descendantPid,"fake descendant started");
 controller.abort();
 await assert.rejects(run,error=>error.code==="PROCESS_CANCELLED");
 await waitDead(descendantPid);
 assert.equal(alive(descendantPid),false,"descendant is no longer running");
});

if (process.platform === "linux") {
 async function processRunning(pid) {
  try {
   const stat=await readFile(`/proc/${pid}/stat`,"utf8");
   const state=stat.match(/^\d+ \(.*\) ([A-Z])/s)?.[1];
   return state!=="Z";
  } catch(error) { if(error.code==="ENOENT") return false; throw error; }
 }
 async function waitStopped(pids) {
  for(let i=0;i<100;i++) {
   if((await Promise.all(pids.map(processRunning))).every(alive=>!alive)) return;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
 }
 function groupAlive(pgid) { try { process.kill(-pgid,0); return true; } catch(error) { return error.code==="EPERM"; } }
 function cleanupGroup(pgid) { if(Number.isInteger(pgid)&&groupAlive(pgid)) { try { process.kill(-pgid,"SIGKILL"); } catch {} } }
 function capturePids(options, run) {
  let text="";
  return runManagedProcess(execPath,["-e",options.code],{
   timeoutMs:10_000,maxStdoutBytes:2048,signal:options.signal,
   onSpawn(pid){options.spawnPid=pid;},
   onStdout(chunk){text+=chunk;const match=text.match(/PIDS:(\d+),(\d+)/);if(match) options.pids=match.slice(1).map(Number);}
  }).then(result=>{if(options.pids===undefined) options.pids=JSON.parse(result.stdout.trim().replace("PIDS:","").split(",")).map(Number); return result;});
 }

 test("Linux cancellation escalates by owned process group after parent exits on SIGTERM",async t=>{
  const controller=new AbortController(),fixture={signal:controller.signal};
  fixture.code="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write('PIDS:'+process.pid+','+child.pid+'\\n');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);";
  const running=capturePids(fixture);
  t.after(()=>cleanupGroup(fixture.spawnPid));
  for(let i=0;i<100&&!fixture.pids;i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(fixture.pids?.[0],fixture.spawnPid,"the process group leader belongs to this fixture");
  controller.abort();
  await assert.rejects(running,error=>error.code==="PROCESS_CANCELLED");
  await waitStopped(fixture.pids);
  assert.equal(await processRunning(fixture.pids[0]),false);
  assert.equal(await processRunning(fixture.pids[1]),false);
 });

 test("Linux normal parent exit does not kill a same-group child until owned cleanup",async t=>{
  const fixture={};
  fixture.code="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('PIDS:'+process.pid+','+child.pid+'\\n');";
  const result=await capturePids(fixture);
  t.after(()=>cleanupGroup(fixture.spawnPid));
  assert.equal(result.stdout.includes("PIDS:"),true);
  assert.deepEqual(fixture.pids?.[0],fixture.spawnPid);
  assert.equal(await processRunning(fixture.pids[1]),true,"a normal parent exit must not signal its child group");
  cleanupGroup(fixture.spawnPid);
  await waitStopped(fixture.pids);
  assert.equal(await processRunning(fixture.pids[1]),false);
 });

 test("Linux process-group cancellation cannot kill a child that detached with setsid",async t=>{
  const controller=new AbortController(),fixture={signal:controller.signal};
  fixture.code="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdout.write('PIDS:'+process.pid+','+child.pid+'\\n');setInterval(()=>{},1000);";
  const running=capturePids(fixture);
  t.after(()=>{if(fixture.pids?.[1]){try{process.kill(-fixture.pids[1],'SIGKILL');}catch{}}cleanupGroup(fixture.spawnPid);});
  for(let i=0;i<100&&!fixture.pids;i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(fixture.pids?.[0],fixture.spawnPid);
  controller.abort();
  await assert.rejects(running,error=>error.code==="PROCESS_CANCELLED");
  assert.equal(await processRunning(fixture.pids[1]),true,"detached child remains outside the parent's group");
  process.kill(-fixture.pids[1],"SIGKILL");
  await waitStopped([fixture.pids[1]]);
  assert.equal(await processRunning(fixture.pids[1]),false,"teardown explicitly kills the owned detached fixture");
 });
}
