import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import http from "node:http";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/utils/errors.js";

const KEY = "dummy-api-key-for-tests-only-0123456789";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fakeJob = { id, videoId:"abcdefghijk", status:"queued", output:"mp4", progress:0 };

async function makeApp(t, opts={}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-fastify-"));
    t.after(() => rm(dir, { recursive:true, force:true }));
    const filePath = path.join(dir, `${id}.mp4`);
    await writeFile(filePath, Buffer.from("0123456789"));
    let releaseCount=0;
    const manager = {
        createDownload: () => { if(opts.queueFull) throw new AppError("queue full",429,"QUEUE_FULL"); if(opts.createError) throw opts.createError; return fakeJob; },
        listDownloads: () => [fakeJob],
        getDownload: jobId => { if(jobId!==id) throw new AppError("missing",404,"JOB_NOT_FOUND"); return fakeJob; },
        cancelDownload: () => ({...fakeJob,status:"cancelled"}),
        acquireDownloadFile: async jobId => { if(jobId!==id) throw new AppError("missing",404,"JOB_NOT_FOUND"); return {filePath,fileName:`${id}.mp4`,fileSize:10,release(){releaseCount++;}}; }
    };
    const app=await buildApp({apiKey:KEY,corsAllowedOrigins:opts.corsAllowedOrigins??[],manager,getVideoInfo:async()=>({id:"abcdefghijk"}),getVideoFormats:async()=>({formats:{video:[],audio:[]}}),globalRateLimit:opts.globalRateLimit??120,...(opts.loggerInstance?{loggerInstance:opts.loggerInstance}:{})});
    t.after(()=>app.close());
    return {app,manager,getReleaseCount:()=>releaseCount};
}

const auth = {"x-api-key":KEY};

test("CORS allows configured localhost origin and its preflight only", async t=>{
 const allowedOrigin="http://127.0.0.1:5500";
 const blockedOrigin="http://evil.example";
 const {app}=await makeApp(t,{corsAllowedOrigins:[allowedOrigin]});

 const preflight=await app.inject({method:"OPTIONS",url:"/api/v1/downloads",headers:{
  origin:allowedOrigin,
  "access-control-request-method":"POST",
  "access-control-request-headers":"content-type,x-api-key"
 }});
 assert.equal(preflight.statusCode,204);
 assert.equal(preflight.headers["access-control-allow-origin"],allowedOrigin);
 assert.match(preflight.headers["access-control-allow-methods"],/POST/);
 assert.match(preflight.headers["access-control-allow-headers"],/x-api-key/i);
 assert.equal(preflight.headers["access-control-allow-credentials"],undefined);

 const allowed=await app.inject({method:"GET",url:"/api/v1/downloads",headers:{origin:allowedOrigin,...auth}});
 assert.equal(allowed.statusCode,200);
 assert.equal(allowed.headers["access-control-allow-origin"],allowedOrigin);

 const blocked=await app.inject({method:"GET",url:"/api/v1/downloads",headers:{origin:blockedOrigin,...auth}});
 assert.equal(blocked.statusCode,200);
 assert.equal(blocked.headers["access-control-allow-origin"],undefined);
});

test("CORS stays disabled by default", async t=>{
 const {app}=await makeApp(t);
 const response=await app.inject({method:"GET",url:"/api/v1/health",headers:{origin:"http://127.0.0.1:5500"}});
 assert.equal(response.statusCode,200);
 assert.equal(response.headers["access-control-allow-origin"],undefined);
});

test("Fastify API health/auth/info/formats/download CRUD and schema errors", async t=>{
 const {app}=await makeApp(t);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/health"})).statusCode,200);
 for(const headers of [{},{"x-api-key":"wrong"},{authorization:"Bearer"},{authorization:"Basic abc"}]) {
  const r=await app.inject({method:"GET",url:"/api/v1/downloads",headers}); assert.equal(r.statusCode,401); assert.doesNotMatch(r.body,/dummy-api-key/);
 }
 assert.equal((await app.inject({method:"GET",url:"/api/v1/info?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabcdefghijk",headers:auth})).statusCode,200);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/formats?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabcdefghijk",headers:{authorization:`Bearer ${KEY}`} })).statusCode,200);
 const created=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp4"}});
 assert.equal(created.statusCode,202);
 assert.equal((await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"bad",formatId:"18",output:"mp4",extra:true}})).statusCode,400);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/downloads",headers:auth})).statusCode,200);
 assert.equal((await app.inject({method:"GET",url:`/api/v1/downloads/${id}`,headers:auth})).statusCode,200);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/downloads/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",headers:auth})).statusCode,404);
 assert.equal((await app.inject({method:"GET",url:"/api/v1/downloads/not-a-uuid",headers:auth})).statusCode,400);
 assert.equal((await app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:auth})).statusCode,200);
 assert.equal((await app.inject({method:"DELETE",url:`/api/v1/downloads/${id}`,headers:auth})).statusCode,200);
});

test("Fastify file route returns 200/206/416 and releases lease once", async t=>{
 const {app,getReleaseCount}=await makeApp(t);
 let r=await app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:auth});
 assert.equal(r.statusCode,200); assert.equal(r.body,"0123456789"); assert.equal(getReleaseCount(),1);
 r=await app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:{...auth,range:"bytes=2-5"}});
 assert.equal(r.statusCode,206); assert.equal(r.headers["content-range"],"bytes 2-5/10"); assert.equal(r.body,"2345"); assert.equal(getReleaseCount(),2);
 for(const range of ["bytes=20-30","bytes=3-2","bytes=1-2,4-5"]) {
  r=await app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:{...auth,range}}); assert.equal(r.statusCode,416);
 }
 assert.equal(getReleaseCount(),5);
});

test("simultaneous clients each acquire and release their own file lease",async t=>{
 const {app,getReleaseCount}=await makeApp(t);
 const responses=await Promise.all([1,2,3].map(()=>app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:auth})));
 assert.ok(responses.every(r=>r.statusCode===200&&r.body==="0123456789"));
 assert.equal(getReleaseCount(),3);
});

test("stream open error releases its lease",async t=>{
 const fixture=await makeApp(t); let released=0;
 fixture.manager.acquireDownloadFile=async()=>({filePath:path.join(os.tmpdir(),`missing-${id}.mp4`),fileName:`${id}.mp4`,fileSize:10,release(){released++;}});
 await fixture.app.inject({method:"GET",url:`/api/v1/downloads/${id}/file`,headers:auth});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(released,1);
});

test("Fastify maps queue saturation and global rate limits to 429", async t=>{
 const {app}=await makeApp(t,{queueFull:true});
 let r=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp4"}});
 assert.equal(r.statusCode,429); assert.equal(r.json().error.code,"QUEUE_FULL");
 const limited=await makeApp(t,{globalRateLimit:2});
 await limited.app.inject({method:"GET",url:"/api/v1/downloads",headers:auth});
 await limited.app.inject({method:"GET",url:"/api/v1/downloads",headers:auth});
 r=await limited.app.inject({method:"GET",url:"/api/v1/downloads",headers:auth});
 assert.equal(r.statusCode,429); assert.equal(r.json().error.code,"RATE_LIMITED");
});

test("route-level info rate limit is independent of global allowance", async t=>{
 const {app}=await makeApp(t,{globalRateLimit:100});
 const url="/api/v1/info?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabcdefghijk";
 let response;
 for(let i=0;i<21;i++) response=await app.inject({method:"GET",url,headers:auth});
 assert.equal(response.statusCode,429); assert.equal(response.json().error.code,"RATE_LIMITED");
});

test("formats and download creation have independent route thresholds and rate headers",async t=>{
 const formats=await makeApp(t,{globalRateLimit:100});
 const formatUrl="/api/v1/formats?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Dabcdefghijk";
 let response;
 for(let i=0;i<21;i++) response=await formats.app.inject({method:"GET",url:formatUrl,headers:auth});
 assert.equal(response.statusCode,429);
 assert.equal(response.json().error.code,"RATE_LIMITED");
 assert.equal(response.headers["x-ratelimit-limit"],"20");
 assert.equal(response.headers["x-ratelimit-remaining"],"0");

 const downloads=await makeApp(t,{globalRateLimit:100});
 const payload={url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp4"};
 for(let i=0;i<10;i++) response=await downloads.app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload});
 assert.equal(response.statusCode,202);
 response=await downloads.app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload});
 assert.equal(response.statusCode,429);
 assert.equal(response.json().error.code,"RATE_LIMITED");
 assert.equal(response.headers["x-ratelimit-limit"],"10");
 assert.equal(response.headers["x-ratelimit-remaining"],"0");
});

test("real HTTP disconnect releases the stream lease once", async t=>{
 const fixture=await makeApp(t);
 // Fastify inject drains responses; use a local ephemeral listener to exercise socket close.
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-disconnect-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,`${id}.mp4`);
 await (await import("node:fs/promises")).writeFile(filePath,Buffer.alloc(32*1024*1024,65));
 fixture.manager.acquireDownloadFile=async()=>({filePath,fileName:`${id}.mp4`,fileSize:32*1024*1024,release(){fixture.releaseCount=(fixture.releaseCount??0)+1;}});
 const address=await fixture.app.listen({host:"127.0.0.1",port:0});
 const controller=new AbortController();
 await new Promise((resolve,reject)=>{
  const request=http.get(`${address}/api/v1/downloads/${id}/file`,{headers:auth},response=>{
   response.once("data",()=>request.destroy());
   response.once("close",resolve);
   response.once("error",resolve);
  });
  request.once("error",error=>error.code==="ECONNRESET"?resolve():reject(error));
 });
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(fixture.releaseCount,1);
});

test("Fastify request logs redact dummy API key and bearer token", async t=>{
 let logs="";
 const sink=new Writable({write(chunk,_encoding,callback){logs+=chunk.toString();callback();}});
 const loggerInstance=pino({level:"info",redact:["req.headers.x-api-key","req.headers.authorization"]},sink);
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-log-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const manager={listDownloads:()=>[],getDownload:()=>fakeJob,createDownload:()=>fakeJob,cancelDownload:()=>fakeJob,acquireDownloadFile:async()=>{throw new AppError("missing",404,"FILE_NOT_FOUND");}};
 const app=await buildApp({apiKey:KEY,manager,getVideoInfo:async()=>({}),getVideoFormats:async()=>({}),loggerInstance}); t.after(()=>app.close());
 await app.inject({method:"GET",url:"/api/v1/downloads",headers:{authorization:`Bearer ${KEY}`}});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(logs.includes(KEY),false);
});

test("unknown internal errors remain generic 500 and do not expose SQL or filesystem details",async t=>{
 let logs="";
 const sink=new Writable({write(chunk,_encoding,callback){logs+=chunk.toString();callback();}});
 const loggerInstance=pino({level:"info"},sink);
 const {app}=await makeApp(t,{loggerInstance,createError:Object.assign(new Error("private SQL at D:/private/jobs.sqlite"),{statusCode:503,code:"SQLITE_INTERNAL_DETAIL"})});
 const response=await app.inject({method:"POST",url:"/api/v1/downloads",headers:{...auth,"content-type":"application/json"},payload:{url:"https://youtube.com/watch?v=abcdefghijk",formatId:"18",output:"mp4"}});
 assert.equal(response.statusCode,500);
 assert.deepEqual(response.json(),{success:false,error:{code:"INTERNAL_ERROR",message:"An unexpected server error occurred"}});
 assert.doesNotMatch(response.body,/private|SQL|jobs\.sqlite|D:\\/i);
 assert.doesNotMatch(logs,/private SQL|jobs\.sqlite|D:\\/i);
});
