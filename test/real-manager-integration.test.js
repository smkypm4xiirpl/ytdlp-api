import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, copyFile, rm, readdir, symlink, truncate } from "node:fs/promises";
import { execPath } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/utils/errors.js";
import { runManagedProcess } from "../src/services/managed-process.js";
import { runYtDlpDownload } from "../src/services/download-process.js";

const root=await mkdtemp(path.join(os.tmpdir(),"ytdlp-real-manager-"));
let manager, store, app;
after(async()=>{
 if(app) await app.close();
 if(manager) await manager.shutdownDownloadManager();
 if(store) store.closeJobStore();
 await rm(root,{recursive:true,force:true});
});
const storage=path.join(root,"storage"), logs=path.join(root,"logs"), cookies=path.join(root,"dummy-cookies.txt"), emptyEnv=path.join(root,"empty.env");
await Promise.all([mkdir(storage),mkdir(logs),writeFile(cookies,""),writeFile(emptyEnv,"")]);
process.env.DOTENV_CONFIG_PATH=emptyEnv;
process.env.API_KEY="dummy-integration-key-for-isolated-tests-only";
process.env.YTDLP_PATH=execPath;
process.env.YTDLP_COOKIES_PATH=cookies;
const mediaBinDir=process.env.YTDLP_TEST_MEDIA_BIN_DIR??(process.platform==="win32"?"D:/Apps/Utilities/Youtube":"/usr/bin");
const mediaSuffix=process.platform==="win32"?".exe":"";
process.env.FFMPEG_PATH=mediaBinDir;
process.env.FFPROBE_PATH=path.join(mediaBinDir,`ffprobe${mediaSuffix}`);
process.env.STORAGE_PATH=storage;
process.env.LOG_PATH=logs;
process.env.DOWNLOAD_CONCURRENCY="2";
process.env.MAX_QUEUE_SIZE="10";
process.env.MAX_FILE_SIZE="1048576";
process.env.MAX_VIDEO_DURATION="14400";
process.env.FILE_TTL_MINUTES="60";

manager=await import("../src/services/download-manager.js");
store=await import("../src/services/job-store.js");
const ffmpeg=path.join(mediaBinDir,`ffmpeg${mediaSuffix}`), ffprobe=path.join(mediaBinDir,`ffprobe${mediaSuffix}`);
const fixtures={};
let lastFfmpegArgs=[];
function run(binary,args){return new Promise((resolve,reject)=>{const c=spawn(binary,args,{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let err="";c.stderr.on("data",x=>err=(err+x).slice(-4000));c.once("error",reject);c.once("close",code=>code===0?resolve():reject(new Error(err)));});}
async function probeMedia(file){return JSON.parse(await new Promise((resolve,reject)=>{const c=spawn(ffprobe,["-v","error","-show_entries","format=format_name:stream=codec_type,codec_name,profile","-of","json",file],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";c.stdout.on("data",chunk=>out+=chunk);c.stderr.on("data",chunk=>err=(err+chunk).slice(-4000));c.once("error",reject);c.once("close",code=>code===0?resolve(out):reject(new Error(err)));}));}
async function makeFixtures(){
 fixtures.mp4=path.join(root,"fixture-opus.mp4");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libx264","-pix_fmt","yuv420p","-c:a","libopus",fixtures.mp4]);
 fixtures.mp4aac=path.join(root,"fixture-aac.mp4");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",fixtures.mp4aac]);
 fixtures.silent=path.join(root,"fixture-silent.mp4");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-c:v","libx264","-pix_fmt","yuv420p",fixtures.silent]);
 fixtures.mkv=path.join(root,"fixture-vp9.mkv");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libvpx-vp9","-c:a","libopus",fixtures.mkv]);
 fixtures.mp3=path.join(root,"fixture.mp3");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","libmp3lame","-q:a","0",fixtures.mp3]);
}
await makeFixtures();
const API_KEY=process.env.API_KEY;
let mode="copy";
const fakeYtdlp=path.join(root,"fake-ytdlp.js");
process.env.PHASE5_FIXTURES=JSON.stringify(fixtures);
process.env.PHASE5_FAKE_MODE=mode;
await writeFile(fakeYtdlp, `
const fs = require('node:fs');
const args = process.argv.slice(3);
const get = name => args[args.indexOf(name) + 1];
const mode = process.env.PHASE5_FAKE_MODE || 'copy';
if (mode === 'fail') { process.stderr.write('controlled fake failure\\n'); process.exit(7); }
if (mode === 'hold') {
  process.stderr.write('__YTDLP_PROGRESS__50|100|100|0|100\\n');
  setInterval(() => {}, 1000);
} else {
  const fixtures = JSON.parse(process.env.PHASE5_FIXTURES);
  const ext = args.includes('--audio-format') ? 'mp3' : get('--merge-output-format');
  if (ext === 'mp3' && (get('--audio-quality') !== '0' || get('--audio-format') !== 'mp3')) throw new Error('unexpected MP3 args');
  if (ext !== 'mp3' && (get('--format') !== '18+bestaudio/18' || get('--remux-video') !== ext)) throw new Error('unexpected video args');
  const outputPath = get('--output').replace('%(ext)s', ext);
  const fixtureKey = mode === 'mp4-aac' ? 'mp4aac' : mode === 'mp4-silent' ? 'silent' : mode === 'mp4-vp9' ? 'mkv' : ext;
  fs.copyFileSync(fixtures[fixtureKey], outputPath);
  process.stderr.write('__YTDLP_PROGRESS__50|50|50|0|100\\n');
  process.stdout.write('__YTDLP_FILE__' + outputPath + '\\n');
}
`);
function setMode(value) { mode=value; process.env.PHASE5_FAKE_MODE=value; }
manager.setDownloadProcessRunner(({args,signal,onProgress})=>{
 if(mode==="enospc-download") return Promise.reject(Object.assign(new Error("fixture full storage"),{code:"ENOSPC"}));
 return runYtDlpDownload({binary:execPath,args:[fakeYtdlp,"--",...args],signal,timeoutMs:10_000,onProgress});
});
manager.setMediaProcessRunner((binary,args,options)=>{
 if(path.basename(binary).startsWith("ffmpeg")) lastFfmpegArgs=[...args];
 if(mode==="enospc-ffmpeg"&&path.basename(binary).startsWith("ffmpeg")) return Promise.reject(Object.assign(new Error("fixture full storage"),{code:"ENOSPC"}));
 return runManagedProcess(binary,args,options).then(async result=>{
  if(mode==="oversized-ffmpeg"&&path.basename(binary).startsWith("ffmpeg")) await truncate(args.at(-1),1_048_577);
  return result;
 });
});

app=await buildApp({apiKey:API_KEY,manager,getVideoInfo:async()=>({id:"abcdefghijk"}),getVideoFormats:async()=>({formats:{video:[],audio:[]}})});
const auth={"x-api-key":API_KEY};
async function resetFastifyRateWindows(){
 await app.close();
 app=await buildApp({apiKey:API_KEY,manager,getVideoInfo:async()=>({id:"abcdefghijk"}),getVideoFormats:async()=>({formats:{video:[],audio:[]}})});
}
async function waitTerminal(id){for(let i=0;i<200;i++){const j=manager.getDownload(id);if(["completed","failed","cancelled"].includes(j.status))return j;await new Promise(r=>setTimeout(r,20));}throw new Error("job timed out in integration harness");}

test("real Fastify + manager + SQLite completes MP4/MKV/MP3 and serves persisted output",async t=>{
 for(const output of ["mp4","mkv","mp3"]){
  const post=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output}});
  assert.equal(post.statusCode,202); const id=post.json().data.id;
  const queued=store.getStoredJob(id); assert.ok(["queued","downloading","processing","completed"].includes(queued.status));
  const done=await waitTerminal(id); assert.equal(done.status,"completed"); assert.ok(done.progress<=100);
  assert.equal(store.getStoredJob(id).status,"completed");
  const detail=await app.inject({method:"GET",url:`/api/v1/downloads/${id}`,headers:auth}); assert.equal(detail.json().data.status,"completed");
  const file=await app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:auth}); assert.equal(file.statusCode,200); assert.ok(file.rawPayload.length>0);
  const lease=await manager.acquireDownloadFile(id);
  try {
   const probe=await probeMedia(lease.filePath);
   if(output==="mp4") { assert.ok(probe.streams.some(s=>s.codec_type==="video"&&s.codec_name==="h264")); assert.ok(probe.streams.some(s=>s.codec_type==="audio"&&s.codec_name==="aac")); }
   if(output==="mkv") { const source=await probeMedia(fixtures.mkv); assert.ok(probe.format.format_name.includes("matroska")); assert.deepEqual(probe.streams.map(s=>s.codec_type+":"+s.codec_name),source.streams.map(s=>s.codec_type+":"+s.codec_name)); }
   if(output==="mp3") { assert.ok(probe.format.format_name.includes("mp3")); assert.deepEqual(probe.streams.map(s=>s.codec_type+":"+s.codec_name),["audio:mp3"]); }
  } finally { lease.release(); }
 }
 const mp3ArgsRun=await app.inject({method:"GET",url:"/api/v1/downloads",headers:auth}); assert.equal(mp3ArgsRun.statusCode,200);
});

test("real manager verifies MP4 AAC copy, no-audio output, and rejects VP9",async()=>{
 await resetFastifyRateWindows();
 for(const item of [{mode:"mp4-aac",expected:"completed"},{mode:"mp4-silent",expected:"completed"},{mode:"mp4-vp9",expected:"failed"}]){
  setMode(item.mode);
  const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp4"}});
  const job=await waitTerminal(response.json().data.id);
  assert.equal(job.status,item.expected);
  if(item.mode==="mp4-aac"){
   assert.equal(lastFfmpegArgs[lastFfmpegArgs.indexOf("-c:a")+1],"copy","AAC-LC is stream copied");
   assert.ok(lastFfmpegArgs.includes("+faststart"));
   const file=await manager.acquireDownloadFile(job.id);
   try { const result=await probeMedia(file.filePath); assert.equal(result.streams.filter(s=>s.codec_type==="audio").length,1); assert.equal(result.streams.find(s=>s.codec_type==="audio").profile,"LC"); }
   finally { file.release(); }
  }
  if(item.mode==="mp4-silent"){
   const file=await manager.acquireDownloadFile(job.id);
   try { const result=await probeMedia(file.filePath); assert.equal(result.streams.filter(s=>s.codec_type==="audio").length,0); }
   finally { file.release(); }
  }
  if(item.mode==="mp4-vp9") assert.equal(job.error.code,"MP4_VIDEO_CODEC_UNSUPPORTED");
 }
 setMode("copy");
});

test("real manager persists failure and cancellation without false completion",async()=>{
 setMode("fail");
 const post=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mkv"}});
 const failed=await waitTerminal(post.json().data.id); assert.equal(failed.status,"failed"); assert.equal(store.getStoredJob(failed.id).status,"failed");
 setMode("hold");
 const activePost=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mkv"}});
 const activeId=activePost.json().data.id;
 for(let i=0;i<50&&manager.getDownload(activeId).status==="queued";i++) await new Promise(r=>setTimeout(r,10));
 assert.equal(manager.getDownload(activeId).status,"downloading");
 for(let i=0;i<100&&manager.getDownload(activeId).progress<50;i++) await new Promise(r=>setTimeout(r,10));
 assert.equal(manager.getDownload(activeId).progress,50);
 assert.equal(store.getStoredJob(activeId).progress,50);
 const cancelled=await app.inject({method:"DELETE",url:`/api/v1/downloads/${activeId}`,headers:auth}); assert.equal(cancelled.statusCode,200);
 const final=await waitTerminal(activeId); assert.equal(final.status,"cancelled"); assert.notEqual(store.getStoredJob(activeId).status,"completed");
 setMode("copy");
});

test("recovery rerun uses SQLite fixture and keeps valid completed result",async()=>{
 await manager.initializeDownloadManager();
 const all=manager.listDownloads(); assert.ok(all.some(job=>job.status==="completed"&&job.fileName));
 const recovered=manager.listDownloads().filter(job=>job.status==="completed");
 for(const job of recovered) assert.equal(store.getStoredJob(job.id).status,"completed");
});

test("actual manager protects active file leases from TTL and releases leases idempotently",async()=>{
 const completed=manager.listDownloads().find(job=>job.status==="completed"&&job.output==="mp4");
 assert.ok(completed);
 const firstPromise=manager.acquireDownloadFile(completed.id);
 const secondPromise=manager.acquireDownloadFile(completed.id);
 await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
 const [first,second]=await Promise.all([firstPromise,secondPromise]);
 assert.ok(await import("node:fs/promises").then(({stat})=>stat(first.filePath)));
 first.release(); first.release();
 await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
 assert.ok(store.getStoredJob(completed.id),"one remaining lease must protect the shared file");
 second.release();
 await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
 assert.throws(()=>manager.getDownload(completed.id),error=>error.code==="JOB_NOT_FOUND");
 assert.equal(store.getStoredJob(completed.id),undefined);
});

test("actual manager refuses expired and externally missing files",async()=>{
 setMode("copy");
 const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp3"}});
 const job=await waitTerminal(response.json().data.id); assert.equal(job.status,"completed");
 const lease=await manager.acquireDownloadFile(job.id); lease.release();
 await rm(lease.filePath,{force:true});
 await assert.rejects(manager.acquireDownloadFile(job.id),error=>error.code==="FILE_NOT_FOUND");
});

test("ENOSPC from downloader and FFmpeg fails durably without a completed artifact",async()=>{
 await resetFastifyRateWindows();
 const cases=[
  {mode:"enospc-download",output:"mkv",code:"STORAGE_WRITE_FAILED"},
  {mode:"enospc-ffmpeg",output:"mp4",code:"STORAGE_WRITE_FAILED"},
  {mode:"insufficient-space",output:"mp4",code:"INSUFFICIENT_STORAGE",hooks:{statfs:async()=>({bavail:0,bsize:4096})}},
  {mode:"rename-failure",output:"mp4",code:"OUTPUT_RENAME_FAILED",hooks:{renameOutput:async()=>{throw Object.assign(new Error("fixture read-only destination"),{code:"EROFS"});}}},
  {mode:"oversized-ffmpeg",output:"mp4",code:"FILE_TOO_LARGE"}
 ];
 for(const item of cases){
  setMode(item.mode);
  manager.setDownloadFileSystemHooks(item.hooks);
  try {
   const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:item.output}});
   assert.equal(response.statusCode,202);
   const job=await waitTerminal(response.json().data.id);
   assert.equal(job.status,"failed",item.mode);
   assert.equal(job.error.code,item.code,item.mode);
   assert.equal(store.getStoredJob(job.id).status,"failed");
   assert.equal(store.getStoredJob(job.id).error.code,item.code);
   await assert.rejects(manager.acquireDownloadFile(job.id),error=>error.code==="FILE_NOT_READY");
   assert.equal(await import("node:fs/promises").then(({stat})=>stat(path.join(storage,`${job.id}.${job.output}`))).then(()=>true,()=>false),false);
   const names=await readdir(storage);
   assert.ok(!names.some(name=>name.startsWith(`${job.id}.`)&&name.endsWith(".processing.mp4")),"temporary output is removed");
   if(item.output==="mp4") assert.ok(names.some(name=>name.startsWith(`${job.id}.`)&&name.includes(".failed.mp4")),"validated original is quarantined");
  } finally { manager.setDownloadFileSystemHooks(); }
 }
 setMode("copy");
 assert.equal((await app.inject({method:"GET",url:"/api/v1/health"})).statusCode,200);
});

test("completed SQLite write failure fails job and quarantines its otherwise valid media",async()=>{
 const fixtureDb=new DatabaseSync(store.databasePath);
 fixtureDb.exec(`CREATE TRIGGER phase5_reject_completed BEFORE UPDATE OF status ON jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`);
 try {
  setMode("copy");
  const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mkv"}});
  const job=await waitTerminal(response.json().data.id);
  assert.equal(job.status,"failed");
  assert.equal(job.error.code,"JOB_PERSISTENCE_FAILED");
  assert.equal(store.getStoredJob(job.id).status,"failed");
  const names=await readdir(storage);
  assert.ok(names.some(name=>name.startsWith(`${job.id}.`)&&name.includes(".failed.mkv")));
  assert.ok(!names.includes(`${job.id}.mkv`));
 } finally {
  fixtureDb.exec("DROP TRIGGER IF EXISTS phase5_reject_completed");
  fixtureDb.close();
 }
});

test("real manager normalizes stored traversal metadata and rejects a symlink output",async t=>{
 setMode("copy");
 const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp3"}});
 const job=await waitTerminal(response.json().data.id);
 assert.equal(job.status,"completed");
 const original=await manager.acquireDownloadFile(job.id);
 original.release();

 const db=new DatabaseSync(store.databasePath);
 try { db.prepare("UPDATE jobs SET file_name=? WHERE id=?").run("../outside.mp3",job.id); }
 finally { db.close(); }
 await manager.initializeDownloadManager();
 assert.equal(manager.getDownload(job.id).fileName,`${job.id}.mp3`);
 const normalized=await manager.acquireDownloadFile(job.id);
 normalized.release();

 const outside=path.join(root,"outside.mp3");
 await copyFile(original.filePath,outside);
 await rm(original.filePath,{force:true});
 try {
  await symlink(outside,original.filePath);
 } catch(error) {
  await copyFile(outside,original.filePath);
  if(["EPERM","EACCES","ENOTSUP"].includes(error.code)) return t.skip(`symlink creation unavailable: ${error.code}`);
  throw error;
 }
 let cleaned=false;
 try {
  await assert.rejects(manager.acquireDownloadFile(job.id),error=>error.code==="INVALID_OUTPUT_FILE");
  await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
  assert.throws(()=>manager.getDownload(job.id),error=>error.code==="JOB_NOT_FOUND");
  cleaned=true;
  assert.equal(await import("node:fs/promises").then(({access})=>access(outside)).then(()=>true,()=>false),true,"cleanup does not follow or remove the symlink target outside storage");
 } finally {
  await rm(original.filePath,{force:true});
  if(!cleaned) await copyFile(outside,original.filePath);
  await rm(outside,{force:true});
 }
});

test("manager retention replays recovery and batch-cleans 1,000 terminal fixture jobs",async()=>{
 const old=new Date(0).toISOString();
 const ids=[];
 for(let i=0;i<1000;i++){
  const id=randomUUID(); ids.push(id);
  store.saveJob({id,videoId:"fixture",formatId:"18",output:"mp4",status:"failed",progress:0,createdAt:old,completedAt:old,fileName:null,fileSize:null,error:{code:"FIXTURE",message:"fixture"}});
 }
 const orphanTemp=path.join(storage,"77777777-7777-4777-8777-777777777777.processing.mp4");
 await writeFile(orphanTemp,"temporary fixture");
 await manager.initializeDownloadManager();
 const firstCount=manager.listDownloads().length;
 assert.ok(firstCount>=1000);
 await manager.initializeDownloadManager();
 assert.equal(manager.listDownloads().length,firstCount,"repeated recovery does not duplicate IDs");
 assert.ok((await readdir(storage)).includes(path.basename(orphanTemp)),"unrecognized processing artifacts are retained for inspection");

 await resetFastifyRateWindows();
 setMode("hold");
 const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mkv"}});
 const activeId=response.json().data.id;
 for(let i=0;i<100&&manager.getDownload(activeId).status==="queued";i++) await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(manager.getDownload(activeId).status,"downloading");
 await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
 assert.equal(manager.getDownload(activeId).status,"downloading");
 assert.equal(store.getStoredJob(activeId).status,"downloading");
 for(const id of ids) assert.equal(store.getStoredJob(id),undefined);

 await app.inject({method:"DELETE",url:`/api/v1/downloads/${activeId}`,headers:auth});
 await waitTerminal(activeId);
 await manager.cleanupExpiredDownloads(Date.now()+2*60*60*1000);
 assert.throws(()=>manager.getDownload(activeId),error=>error.code==="JOB_NOT_FOUND");
 setMode("copy");
});
