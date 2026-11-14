import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteJobStore } from "../src/services/sqlite-store-core.js";

if (process.platform === "linux") {
    const mediaBinDir = process.env.YTDLP_TEST_MEDIA_BIN_DIR ?? "/usr/bin";
    const bootstrapScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "test-support", "server-bootstrap-child.js");
    const lockName = ".ytdlp-api.lock";

    async function processRunning(pid) {
        try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            return stat.match(/^\d+ \(.*\) ([A-Z])/s)?.[1] !== "Z";
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }

    async function waitFor(predicate, message, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const result = await predicate();
            if (result) return result;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(typeof message === "function" ? message() : message);
    }

    function launch(root, fakeYtdlp, { shutdownMs = 5000, hangShutdown = false, ignoreTerm = false } = {}) {
        const child = spawn(execPath, [bootstrapScript, root, mediaBinDir, fakeYtdlp, String(shutdownMs), String(hangShutdown), String(ignoreTerm)], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false
        });
        let stdout = "", stderr = "", lines = [];
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => {
            stdout += chunk;
            const complete = stdout.split("\n");
            stdout = complete.pop() ?? "";
            for (const line of complete) {
                try { lines.push(JSON.parse(line)); } catch {}
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
        return { child, lines, get stderr() { return stderr; } };
    }

    async function nextMessage(server, type, timeoutMs = 10_000) {
        return waitFor(() => {
            const expected = server.lines.find(message => message.type === type);
            if (expected) return expected;
            const startupError = server.lines.find(message => message.type === "startup-error");
            if (startupError) throw new Error(`fixture startup failed: ${startupError.code}: ${startupError.message}; ${server.stderr}`);
            return null;
        }, () => `fixture server did not emit ${type}; ${server.stderr}`, timeoutMs);
    }

    async function waitClose(child, timeoutMs = 10_000) {
        if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("fixture server did not exit within deadline")), timeoutMs);
            child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        });
    }

    async function createFixture(root) {
        const storage = path.join(root, "storage", "downloads");
        await Promise.all([
            mkdir(storage, { recursive: true }),
            mkdir(path.join(root, "logs"), { recursive: true }),
            writeFile(path.join(root, "cookies.fixture"), ""),
            writeFile(path.join(root, "empty.env"), "")
        ]);
        const fakeYtdlp = path.join(root, "fake-ytdlp.js");
        await writeFile(fakeYtdlp, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PHASE6_PID_FILE,String(process.pid));
process.stderr.write('__YTDLP_PROGRESS__50|100|100|0|100\\n');
if(process.env.PHASE6_IGNORE_TERM==='1') process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
        return { storage, fakeYtdlp, dbPath: path.join(root, "storage", "jobs.sqlite"), lockPath: path.join(root, "storage", lockName), pidPath: path.join(root, "fake-downloader.pid") };
    }

    function queuedRow(id) {
        const old = new Date(0).toISOString();
        return { id, videoId: "abcdefghijk", formatId: "18", output: "mp4", status: "queued", progress: 0, createdAt: old, startedAt: null, completedAt: null };
    }

    test("Linux real bootstrap recovers before listen, rejects second instance, and shuts down active job cleanly", async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), "ytdlp-bootstrap-linux-"));
        const fixture = await createFixture(root);
        const queuedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const seed = openSqliteJobStore(fixture.dbPath, { lock: false });
        seed.saveJob(queuedRow(queuedId));
        seed.close();
        let running = null;
        t.after(async () => {
            if (running?.child.exitCode === null && running?.child.signalCode === null) running.child.kill("SIGKILL");
            try {
                const pid = Number(await readFile(fixture.pidPath, "utf8"));
                if (Number.isInteger(pid) && await processRunning(pid)) process.kill(-pid, "SIGKILL");
            } catch {}
            await rm(root, { recursive: true, force: true });
        });

        running = launch(root, fixture.fakeYtdlp);
        const ready = await nextMessage(running, "ready");
        assert.ok(ready.port > 0);
        assert.equal(await access(fixture.lockPath).then(() => true, () => false), true);
        const base = `http://127.0.0.1:${ready.port}`;
        const key = "phase6-isolated-bootstrap-dummy-key-only";
        const recoveredResponse = await fetch(`${base}/api/v1/downloads/${queuedId}`, { headers: { "x-api-key": key } });
        assert.equal(recoveredResponse.status, 200);
        assert.equal((await recoveredResponse.json()).data.status, "interrupted");

        const second = launch(root, fixture.fakeYtdlp);
        const rejected = await nextMessage(second, "startup-error");
        assert.equal(rejected.code, "INSTANCE_LOCKED");
        assert.equal((await waitClose(second.child)).code, 2);
        assert.equal(running.child.exitCode, null, "first instance remains available after rejection");

        const post = await fetch(`${base}/api/v1/downloads`, {
            method: "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({ url: "https://youtube.com/watch?v=abcdefghijk", formatId: "18", output: "mkv" })
        });
        assert.equal(post.status, 202);
        const activeId = (await post.json()).data.id;
        const fakePid = await waitFor(async () => Number(await readFile(fixture.pidPath, "utf8")).catch(() => 0) || null, "fake downloader did not start");
        assert.equal(await processRunning(fakePid), true);
        const detail = await fetch(`${base}/api/v1/downloads/${activeId}`, { headers: { "x-api-key": key } });
        assert.equal((await detail.json()).data.status, "downloading");

        running.child.kill("SIGTERM");
        assert.equal((await waitClose(running.child)).code, 0);
        await waitFor(async () => !(await processRunning(fakePid)), "owned fake downloader survived graceful shutdown");
        assert.equal(await access(fixture.lockPath).then(() => true, () => false), false);
        const verify = openSqliteJobStore(fixture.dbPath, { lock: false });
        assert.equal(verify.getStoredJob(activeId).status, "cancelled");
        assert.equal(verify.getStoredJob(queuedId).status, "interrupted");
        verify.close();

        const restarted = launch(root, fixture.fakeYtdlp);
        const restartedReady = await nextMessage(restarted, "ready");
        const status = await fetch(`http://127.0.0.1:${restartedReady.port}/api/v1/downloads/${activeId}`, { headers: { "x-api-key": key } });
        assert.equal((await status.json()).data.status, "cancelled");
        restarted.child.kill("SIGTERM");
        assert.equal((await waitClose(restarted.child)).code, 0);
        assert.equal(await access(fixture.lockPath).then(() => true, () => false), false);
        running = restarted;
    });

    test("Linux shutdown deadline force-kills an owned TERM-resistant child and leaves recoverable SQLite/lock state", async t => {
        const root = await mkdtemp(path.join(os.tmpdir(), "ytdlp-shutdown-deadline-linux-"));
        const fixture = await createFixture(root);
        let running = null;
        t.after(async () => {
            if (running?.child.exitCode === null && running?.child.signalCode === null) running.child.kill("SIGKILL");
            try {
                const pid = Number(await readFile(fixture.pidPath, "utf8"));
                if (Number.isInteger(pid) && await processRunning(pid)) process.kill(-pid, "SIGKILL");
            } catch {}
            await rm(root, { recursive: true, force: true });
        });

        running = launch(root, fixture.fakeYtdlp, { shutdownMs: 1000, hangShutdown: true, ignoreTerm: true });
        const ready = await nextMessage(running, "ready");
        const key = "phase6-isolated-bootstrap-dummy-key-only";
        const post = await fetch(`http://127.0.0.1:${ready.port}/api/v1/downloads`, {
            method: "POST",
            headers: { "x-api-key": key, "content-type": "application/json" },
            body: JSON.stringify({ url: "https://youtube.com/watch?v=abcdefghijk", formatId: "18", output: "mkv" })
        });
        const activeId = (await post.json()).data.id;
        const fakePid = await waitFor(async () => Number(await readFile(fixture.pidPath, "utf8")).catch(() => 0) || null, "TERM-resistant child did not start");
        running.child.kill("SIGTERM");
        assert.equal((await waitClose(running.child, 5000)).code, 42);
        assert.ok(running.lines.some(message => message.type === "shutdown-deadline"));
        await waitFor(async () => !(await processRunning(fakePid)), "forced shutdown left its owned child alive");
        assert.equal(await access(fixture.lockPath).then(() => true, () => false), true, "forced exit intentionally leaves stale lock for operator/recovery");
        const inspect = openSqliteJobStore(fixture.dbPath, { lock: false });
        assert.equal(inspect.getStoredJob(activeId).status, "downloading");
        inspect.close();

        await rm(fixture.lockPath, { force: true });
        running = launch(root, fixture.fakeYtdlp);
        const recovered = await nextMessage(running, "ready");
        const status = await fetch(`http://127.0.0.1:${recovered.port}/api/v1/downloads/${activeId}`, { headers: { "x-api-key": key } });
        assert.equal((await status.json()).data.status, "interrupted");
        running.child.kill("SIGTERM");
        assert.equal((await waitClose(running.child)).code, 0);
        assert.equal(await access(fixture.lockPath).then(() => true, () => false), false);
    });
}
