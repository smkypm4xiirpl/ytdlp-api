import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedNodeVersion, isSupportedNodeVersion } from "../src/runtime-requirements.js";

test("runtime minimum matches node:sqlite DatabaseSync.isOpen availability", () => {
    assert.equal(isSupportedNodeVersion("22.14.0"), false);
    assert.equal(isSupportedNodeVersion("v22.15.0"), true);
    assert.equal(isSupportedNodeVersion("22.23.3"), true);
    assert.equal(isSupportedNodeVersion("23.0.0"), true);
    assert.equal(isSupportedNodeVersion("not-a-node-version"), false);
    assert.doesNotThrow(() => assertSupportedNodeVersion("22.15.0"));
    assert.throws(() => assertSupportedNodeVersion("22.14.0"), /requires Node\.js >=22\.15\.0/);
});
