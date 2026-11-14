import test from "node:test";
import assert from "node:assert/strict";
import PQueue from "p-queue";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("p-queue concurrency, pending+waiting capacity and simultaneous admission", async () => {
    const queue = new PQueue({ concurrency: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0, peak = 0, started = 0;
    const tasks = gates.map(g => queue.add(async () => { started++; running++; peak = Math.max(peak, running); await g.promise; running--; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.pending, 2);
    assert.equal(queue.size, 2);
    assert.equal(queue.pending + queue.size, 4);
    assert.equal(started, 2);
    gates.forEach(g => g.resolve());
    await Promise.all(tasks);
    assert.equal(peak, 2);
});

test("abort removes a queued task and running cancellation settles task", async () => {
    const queue = new PQueue({ concurrency: 1 });
    const gate = deferred();
    const active = queue.add(() => gate.promise);
    const controller = new AbortController();
    let queuedStarted = false;
    const queued = queue.add(() => { queuedStarted = true; }, { signal: controller.signal });
    const keepAlive = setTimeout(() => {}, 2000);
    controller.abort();
    try {
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(queue.size, 1, "p-queue v8 leaves aborted waiter until it reaches the head");
        gate.resolve();
        await active;
        await assert.rejects(queued);
        assert.equal(queue.size, 0);
        assert.equal(queuedStarted, false);
    } finally { clearTimeout(keepAlive); gate.resolve(); }
});

test("task rejection does not block later queue work", async () => {
    const queue = new PQueue({ concurrency: 1 });
    await assert.rejects(queue.add(() => { throw new Error("fixture"); }));
    assert.equal(await queue.add(() => "ok"), "ok");
    await queue.onIdle();
});

test("running cancellation settles active operation and queue reaches idle", async () => {
    const queue = new PQueue({ concurrency: 1 });
    const controller = new AbortController();
    let executionCount = 0;
    const active = queue.add(({ signal }) => {
        executionCount++;
        return new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
    }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error("cancel fixture"));
    await assert.rejects(active);
    await queue.onIdle();
    assert.equal(executionCount, 1);
    assert.equal(queue.pending, 0);
});
