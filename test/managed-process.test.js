import test from "node:test";
import assert from "node:assert/strict";
import { runManagedProcess } from "../src/services/managed-process.js";
import { execPath } from "node:process";

test("managed process bounds output and captures successful stdout", async () => {
    const result = await runManagedProcess(execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5000, maxStdoutBytes: 16 });
    assert.equal(result.stdout, "ok");
});

test("managed process reports timeout and nonzero exit", async () => {
    await assert.rejects(runManagedProcess(execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 100, maxStdoutBytes: 16 }), (error) => error.code === "PROCESS_TIMEOUT");
    await assert.rejects(runManagedProcess(execPath, ["-e", "process.exit(7)"], { timeoutMs: 5000 }), (error) => error.code === "PROCESS_EXIT_NONZERO");
});

test("managed process reports missing executable", async () => {
    await assert.rejects(runManagedProcess("Z:/definitely-missing-ytdlp-executable.exe", [], { timeoutMs: 500 }), (error) => error.code === "PROCESS_START_FAILED");
});
