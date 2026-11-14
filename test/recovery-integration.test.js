import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, copyFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { recoverDownloadJobs } from "../src/services/recovery.js";
import { openSqliteJobStore } from "../src/services/sqlite-store-core.js";

const mediaBinDir=process.env.YTDLP_TEST_MEDIA_BIN_DIR??(process.platform==="win32"?"D:/Apps/Utilities/Youtube":"/usr/bin");
const suffix=process.platform==="win32"?".exe":"";
const ffmpeg=path.join(mediaBinDir,`ffmpeg${suffix}`),ffprobe=path.join(mediaBinDir,`ffprobe${suffix}`);
const ids={valid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",missing:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",corrupt:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",mismatch:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",queued:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",downloading:"ffffffff-ffff-4fff-8fff-ffffffffffff",processing:"11111111-1111-4111-8111-111111111111",orphan:"22222222-2222-4222-8222-222222222222",badOrphan:"33333333-3333-4333-8333-333333333333"};
function run(bin,args){return new Promise((resolve,reject)=>{const c=spawn(bin,args,{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="";c.stdout.on("data",x=>out+=x);c.stderr.on("data",x=>err=(err+x).slice(-5000));c.once("error",reject);c.once("close",code=>code===0?resolve(out):reject(new Error(err)));});}
function row(id,status,output="mp4"){return {id,videoId:"abcdefghijk",formatId:"18",output,status,progress:17,createdAt:new Date(0).toISOString(),completedAt:status==="completed"?new Date(0).toISOString():null,fileName:status==="completed"?`${id}.${output}`:null};}
async function probe(file){return JSON.parse(await run(ffprobe,["-v","error","-show_entries","format=format_name:stream=codec_type,codec_name,profile","-of","json",file]));}

test("service recovery converts active rows to interrupted; validates saved files and handles orphans safely",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-recovery-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=openSqliteJobStore(path.join(dir,"jobs.sqlite")); const storePath=path.join(dir,"downloads"); await import("node:fs/promises").then(({mkdir})=>mkdir(storePath));
 const valid=path.join(dir,"valid.mp4");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-f","lavfi","-i","sine=frequency=440:duration=1","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",valid]);
 await copyFile(valid,path.join(storePath,`${ids.valid}.mp4`));
 await writeFile(path.join(storePath,`${ids.corrupt}.mp4`),"not media");
 const vp9=path.join(dir,"vp9.mp4"); await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-c:v","libvpx-vp9",vp9]); await copyFile(vp9,path.join(storePath,`${ids.mismatch}.mp4`));
 await copyFile(valid,path.join(storePath,`${ids.orphan}.mp4`));
 await copyFile(valid,path.join(storePath,`${ids.badOrphan}.processing.mp4`));
 const rows=[row(ids.valid,"completed"),row(ids.missing,"completed"),row(ids.corrupt,"completed"),row(ids.mismatch,"completed"),row(ids.queued,"queued"),row(ids.downloading,"downloading"),row(ids.processing,"processing"),row("../escape","completed")];
 for(const r of rows) db.saveJob(r);
 const jobs=await recoverDownloadJobs({storedJobs:db.listStoredJobs(),storagePath:storePath,maxFileSize:10_000_000,probe,persist:job=>db.saveJob(job)});
 assert.equal(jobs.get(ids.valid).status,"completed");
 assert.equal(jobs.get(ids.missing).status,"failed");
 assert.equal(jobs.get(ids.corrupt).status,"failed");
 assert.equal(jobs.get(ids.mismatch).status,"failed");
 for(const key of ["queued","downloading","processing"]) assert.equal(jobs.get(ids[key]).status,"interrupted");
 assert.equal(jobs.get(ids.orphan).status,"completed");
 assert.equal(jobs.get("../escape").status,"failed");
 assert.equal(jobs.has(ids.badOrphan),false);
 assert.ok((await readdir(storePath)).includes(`${ids.badOrphan}.processing.mp4`),"temporary/unrecognized files are left untouched");
 assert.equal(db.getStoredJob(ids.queued).status,"interrupted");
 db.close();
});

test("empty startup recovery returns an empty job map",async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-empty-recovery-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const storage=path.join(dir,"downloads");await import("node:fs/promises").then(({mkdir})=>mkdir(storage));
 const jobs=await recoverDownloadJobs({storedJobs:[],storagePath:storage,maxFileSize:1024,probe,persist:()=>{throw new Error("unexpected persistence");}});
 assert.equal(jobs.size,0);
});
