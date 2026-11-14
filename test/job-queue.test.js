import test from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/services/job-queue.js";

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test("job queue enforces concurrency and removes many cancelled waiters immediately", async () => {
    const queue = new JobQueue(1);
    const gate = deferred();
    let started = 0;
    const active = queue.add(async () => { started++; await gate.promise; });
    await new Promise(resolve => setImmediate(resolve));

    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const cancelled = controllers.map(controller => queue.add(() => { started++; }, { signal: controller.signal }));
    assert.equal(queue.pending, 1);
    assert.equal(queue.size, 100);
    for (const controller of controllers) controller.abort();
    const rejected = await Promise.allSettled(cancelled);
    assert.ok(rejected.every(result => result.status === "rejected"));
    assert.equal(queue.size, 0);

    const next = queue.add(() => { started++; return "next"; });
    assert.equal(queue.size, 1);
    gate.resolve();
    await active;
    assert.equal(await next, "next");
    await queue.onIdle();
    assert.equal(started, 2, "cancelled queued jobs are never executed");
    assert.equal(queue.pending, 0);
});

test("job queue keeps running slots until abort-aware work actually settles", async () => {
    const queue = new JobQueue(1);
    const controller = new AbortController();
    const active = queue.add(({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => setTimeout(() => reject(new Error("stopped")), 10), { once: true });
    }), { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal(queue.pending, 1);
    await assert.rejects(active, /stopped/);
    await queue.onIdle();
    assert.equal(queue.pending, 0);
});
