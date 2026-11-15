import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execPath } from "node:process";
import { spawn } from "node:child_process";
import { openSqliteJobStore } from "../src/services/sqlite-store-core.js";

function record(id, status="queued") { return { id, videoId:"abcdefghijk", formatId:"18", output:"mp4", status, progress:0, createdAt:new Date().toISOString() }; }
function child(code) { return new Promise((resolve,reject) => { const c=spawn(execPath,["--input-type=module","-e",code],{shell:false,windowsHide:true,stdio:"ignore"}); c.once("error",reject); c.once("close",(code,signal)=>resolve({code,signal})); }); }

test("SQLite job store CRUD and simultaneous persistence on isolated database", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-sqlite-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=openSqliteJobStore(path.join(dir,"jobs.sqlite"));
 const jobs=Array.from({length:25},(_,i)=>record(`id-${i}`));
 for (const job of jobs) store.saveJob(job);
 assert.equal(store.listStoredJobs().length,25);
 assert.equal(store.getStoredJob("id-4").status,"queued");
 store.saveJob(record("id-4","completed"));
 assert.equal(store.getStoredJob("id-4").status,"completed");
 store.deleteStoredJob("id-4"); assert.equal(store.getStoredJob("id-4"),undefined);
 store.close();
});

test("initial create is insert-only and cannot overwrite a colliding job ID",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-create-only-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=openSqliteJobStore(path.join(dir,"jobs.sqlite"));
 try {
  store.createJob(record("collision","queued"));
  assert.throws(()=>store.createJob({...record("collision","completed"),fileName:"collision.mp4",fileSize:10}));
  assert.equal(store.getStoredJob("collision").status,"queued");
  assert.equal(store.getStoredJob("collision").fileName,null);
 } finally { store.close(); }
});

test("SQLite rejects duplicate instance lock and stale lock is explicit", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-lock-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=path.join(dir,"jobs.sqlite"); const first=openSqliteJobStore(db);
 assert.throws(()=>openSqliteJobStore(db),e=>e.code==="INSTANCE_LOCKED");
 const moduleUrl=`file:///${path.resolve("src/services/sqlite-store-core.js").replaceAll("\\","/")}`;
 const childCode=`import {openSqliteJobStore} from ${JSON.stringify(moduleUrl)}; try { openSqliteJobStore(${JSON.stringify(db)}); process.exit(4); } catch(e) { process.exit(e.code === 'INSTANCE_LOCKED' ? 0 : 5); }`;
 assert.equal((await child(childCode)).code,0,"separate process is rejected while owner holds lock");
 first.close();
 const lock=`${db}.lock`; fs.writeFileSync(lock,"stale pid\n");
 assert.throws(()=>openSqliteJobStore(db),e=>e.code==="INSTANCE_LOCKED");
 fs.unlinkSync(lock); const reopened=openSqliteJobStore(db); reopened.close();
});

test("SQLite busy timeout and WAL checkpoint are observable on fixture database", async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-busy-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=path.join(dir,"jobs.sqlite"); const first=openSqliteJobStore(db,{busyTimeoutMs:100}); const second=openSqliteJobStore(db,{lock:false,busyTimeoutMs:100});
 try {
  first.saveJob(record("busy"));
  first.database.exec("BEGIN EXCLUSIVE");
  assert.throws(()=>second.saveJob(record("blocked")),e=>String(e.message).includes("locked"));
  first.database.exec("ROLLBACK");
  const checkpoint=first.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  assert.equal(checkpoint.busy,0);
 } finally { second.close(); first.close(); }
});

test("abrupt process exit leaves WAL data durable and lock stale by design", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-crash-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=path.join(dir,"jobs.sqlite");
 const source=path.resolve("src/services/sqlite-store-core.js").replaceAll("\\","/");
 const code=`import {openSqliteJobStore} from 'file:///${source}'; const s=openSqliteJobStore(${JSON.stringify(db)}); s.saveJob(${JSON.stringify(record("crash-job","completed"))}); process.exit(0);`;
 const {code:exitCode}=await child(code); assert.equal(exitCode,0);
 assert.throws(()=>openSqliteJobStore(db),e=>e.code==="INSTANCE_LOCKED");
 fs.unlinkSync(`${db}.lock`);
 const reopened=openSqliteJobStore(db); assert.equal(reopened.getStoredJob("crash-job").status,"completed"); reopened.close();
});

test("SQLite write failures propagate to caller", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-writefail-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=openSqliteJobStore(path.join(dir,"jobs.sqlite"));
 store.database.exec("CREATE TRIGGER fail_write BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
 assert.throws(()=>store.saveJob(record("failure")));
 assert.equal(store.getStoredJob("failure"),undefined); store.close();
});

test("SQLite delete failure propagates and leaves durable row intact", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-deletefail-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=openSqliteJobStore(path.join(dir,"jobs.sqlite")); store.saveJob(record("kept"));
 store.database.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
 assert.throws(()=>store.deleteStoredJob("kept"));
 assert.equal(store.getStoredJob("kept").id,"kept"); store.close();
});

test("SQLite read failure propagates instead of returning empty data", async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-readfail-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=openSqliteJobStore(path.join(dir,"jobs.sqlite")); store.database.close();
 assert.throws(()=>store.listStoredJobs());
 store.close();
});
