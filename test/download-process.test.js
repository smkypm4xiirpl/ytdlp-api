import test from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { runYtDlpDownload, downloadTimeoutMs } from "../src/services/download-process.js";

const fake = (code) => ["-e", code];

test("download runner returns only a reported final path and parses progress", async () => {
    const lines = [];
    const result = await runYtDlpDownload({ binary: execPath, args: fake("process.stderr.write('__YTDLP_PROGRESS__1|2|2|1|1\\n'); process.stdout.write('__YTDLP_FILE__C:/temp/out.mp4\\n')"), timeoutMs: 3000, onProgress: line => lines.push(line) });
    assert.equal(result, "C:/temp/out.mp4");
    assert.match(lines.join("\n"), /__YTDLP_PROGRESS__/);
});

test("download runner distinguishes timeout, user abort, output limit, start and exit failures", async () => {
    const cases = [
        ["timeout", () => runYtDlpDownload({ binary: execPath, args: fake("setTimeout(()=>{},10000)"), timeoutMs: 100 }), "YTDLP_TIMEOUT"],
        ["cancel", () => { const c = new AbortController(); c.abort(); return runYtDlpDownload({ binary: execPath, args: [], signal: c.signal, timeoutMs: 500 }); }, "DOWNLOAD_CANCELLED"],
        ["output", () => runYtDlpDownload({ binary: execPath, args: fake("process.stdout.write('x'.repeat(70000))"), timeoutMs: 3000 }), "YTDLP_OUTPUT_TOO_LARGE"],
        ["missing", () => runYtDlpDownload({ binary: "Z:/missing-ytdlp.exe", args: [], timeoutMs: 500 }), "YTDLP_START_FAILED"],
        ["exit", () => runYtDlpDownload({ binary: execPath, args: fake("process.exit(3)"), timeoutMs: 3000 }), "DOWNLOAD_FAILED"]
    ];
    for (const [label, makePromise, code] of cases) await assert.rejects(makePromise(), error => error.code === code, label);
});

test("download timeout policy is bounded and scales with max video duration", () => {
    assert.equal(downloadTimeoutMs(14400), (14400 + 600) * 1000);
    assert.equal(downloadTimeoutMs(86400), 6 * 60 * 60 * 1000);
    assert.ok(downloadTimeoutMs(30) >= 30 * 60 * 1000);
});
