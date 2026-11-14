import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyMediaOutput } from "../src/services/media-policy.js";
import { spawn } from "node:child_process";

const executableSuffix = process.platform === "win32" ? ".exe" : "";
const binDir = process.env.YTDLP_TEST_MEDIA_BIN_DIR ??
    (process.platform === "win32" ? "D:/Apps/Utilities/Youtube" : "/usr/bin");
const ffmpeg = path.join(binDir, `ffmpeg${executableSuffix}`);
const ffprobe = path.join(binDir, `ffprobe${executableSuffix}`);

function run(binary, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err = (err + chunk).slice(-8192); });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(out) : reject(new Error(`process exit ${code}: ${err}`)));
    });
}

const available = await Promise.all([ffmpeg, ffprobe].map(async (p) => {
    try { await import("node:fs/promises").then(({ access }) => access(p)); return true; } catch { return false; }
}));

test("synthetic MP4 codec policy, multi-audio preservation, and faststart", { skip: !available.every(Boolean) }, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-media-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const src = path.join(dir, "source.mp4");
    const out = path.join(dir, "result.mp4");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a:0", "aac", "-c:a:1", "libopus", "-shortest", src]);
    const before = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", src]));
    assert.deepEqual(before.streams.filter(s => s.codec_type === "audio").map(s => s.codec_name), ["aac", "opus"]);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", src, "-map", "0:v?", "-map", "0:a?", "-map_metadata", "0", "-map_chapters", "0", "-c:v", "copy", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "256k", "-sn", "-dn", "-movflags", "+faststart", out]);
    const after = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name,profile", "-of", "json", out]));
    assert.equal(after.streams.filter(s => s.codec_type === "video").every(s => s.codec_name === "h264"), true);
    assert.equal(after.streams.filter(s => s.codec_type === "audio").length, 2);
    assert.equal(after.streams.filter(s => s.codec_type === "audio").every(s => s.codec_name === "aac"), true);
    assert.equal(after.streams.filter(s => s.codec_type === "audio").every(s => s.profile === "LC"), true);
    const data = await import("node:fs/promises").then(({ readFile }) => readFile(out));
    const moov = data.indexOf(Buffer.from("moov"));
    const mdat = data.indexOf(Buffer.from("mdat"));
    assert.ok(moov >= 0 && mdat >= 0 && moov < mdat, "moov atom precedes mdat (faststart)");
});

test("synthetic AAC-only audio is copied and silent H.264 MP4 remains valid", { skip: !available.every(Boolean) }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-media-cases-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const silent = path.join(dir, "silent.mp4"), silentOut = path.join(dir, "silent-fast.mp4");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=5:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", silent, "-map", "0:v?", "-map", "0:a?", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", silentOut]);
    const silentInfo = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name", "-of", "json", silentOut]));
    assert.equal(silentInfo.streams.filter(s => s.codec_type === "audio").length, 0);
    assert.ok(silentInfo.format.format_name.includes("mp4"));

    const aac = path.join(dir, "aac.mp4"), copied = path.join(dir, "aac-copy.mp4");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=5:duration=1", "-f", "lavfi", "-i", "sine=frequency=600:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", aac]);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", aac, "-map", "0:v?", "-map", "0:a?", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", copied]);
    const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", copied]));
    assert.equal(probe.streams.filter(s => s.codec_type === "audio").length, 1);
    assert.equal(probe.streams.find(s => s.codec_type === "audio").codec_name, "aac");
});

test("corrupt synthetic media is rejected by ffprobe", { skip: !available.every(Boolean) }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-corrupt-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const bad = path.join(dir, "bad.mp4");
    await (await import("node:fs/promises")).writeFile(bad, "not a media container");
    await assert.rejects(run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", bad]));
});

test("synthetic MKV remux preserves every source stream and MP3 extraction is valid", { skip: !available.every(Boolean) }, async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-mkv-mp3-")); t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,"source.mp4"),mkv=path.join(dir,"result.mkv"),mp3=path.join(dir,"audio.mp3");
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-f","lavfi","-i","sine=frequency=550:duration=1","-f","lavfi","-i","sine=frequency=800:duration=1","-map","0:v","-map","1:a","-map","2:a","-c:v","libx264","-pix_fmt","yuv420p","-c:a:0","aac","-c:a:1","libopus",source]);
 const before=JSON.parse(await run(ffprobe,["-v","error","-show_entries","stream=codec_type,codec_name","-of","json",source]));
 await run(ffmpeg,["-hide_banner","-loglevel","error","-i",source,"-map","0","-c","copy",mkv]);
 const after=JSON.parse(await run(ffprobe,["-v","error","-show_entries","format=format_name:stream=codec_type,codec_name","-of","json",mkv]));
 assert.ok(after.format.format_name.includes("matroska"));
 assert.deepEqual(after.streams.map(s=>s.codec_type+":"+s.codec_name),before.streams.map(s=>s.codec_type+":"+s.codec_name));
 verifyMediaOutput("mkv",after);
 await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=1","-vn","-c:a","libmp3lame","-q:a","0",mp3]);
 const mp3info=JSON.parse(await run(ffprobe,["-v","error","-show_entries","format=format_name:stream=codec_type,codec_name","-of","json",mp3]));
 assert.ok(mp3info.format.format_name.includes("mp3")); assert.equal(mp3info.streams.length,1); assert.deepEqual(mp3info.streams[0],{codec_type:"audio",codec_name:"mp3"});
 verifyMediaOutput("mp3",mp3info);
});

test("synthetic VP9 and AV1 MP4 containers are rejected by output codec policy",{skip:!available.every(Boolean)},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"ytdlp-codec-reject-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [encoder,expected] of [["libvpx-vp9","vp9"],["libaom-av1","av1"]]){
  const file=path.join(dir,`${expected}.mp4`);
  await run(ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=128x72:rate=5:duration=1","-an","-c:v",encoder,...(encoder==="libaom-av1"?["-cpu-used","8"]:[]),file]);
  const info=JSON.parse(await run(ffprobe,["-v","error","-show_entries","format=format_name:stream=codec_type,codec_name,profile","-of","json",file]));
  assert.equal(info.streams.find(s=>s.codec_type==="video").codec_name,expected);
  assert.throws(()=>verifyMediaOutput("mp4",info),error=>error.code==="MP4_VIDEO_CODEC_UNSUPPORTED");
 }
});
