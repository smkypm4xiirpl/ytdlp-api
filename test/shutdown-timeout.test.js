import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/utils/with-timeout.js";

test("shutdown helper resolves normal close and clears its deadline", async () => {
    let timedOut = false;
    assert.equal(await withTimeout(async () => "closed", 100, () => { timedOut = true; }), "closed");
    assert.equal(timedOut, false);
});

test("shutdown helper enforces a hard deadline and invokes escalation", async () => {
    let escalated = false;
    await assert.rejects(
        withTimeout(() => new Promise(() => {}), 20, () => { escalated = true; }),
        error => error.code === "OPERATION_TIMEOUT"
    );
    assert.equal(escalated, true);
});
