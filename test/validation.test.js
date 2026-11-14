import test from "node:test";
import assert from "node:assert/strict";
import { validateYouTubeUrl } from "../src/utils/validation.js";

const id = "abcdefghijk";

test("accepts supported single-video URL forms", () => {
    for (const url of [
        `https://www.youtube.com/watch?v=${id}`,
        `https://youtu.be/${id}`,
        `https://m.youtube.com/shorts/${id}`,
        `https://music.youtube.com/live/${id}`
    ]) assert.equal(validateYouTubeUrl(url).videoId, id);
});

test("rejects non-YouTube hosts, ports, credentials, and protocols", () => {
    for (const url of [
        `https://youtube.com.evil.test/watch?v=${id}`,
        `https://youtube.com:8443/watch?v=${id}`,
        `https://user:pass@youtube.com/watch?v=${id}`,
        `file://youtube.com/watch?v=${id}`
    ]) assert.throws(() => validateYouTubeUrl(url));
});

test("rejects playlist and extra query parameters", () => {
    assert.throws(() => validateYouTubeUrl(`https://youtube.com/watch?v=${id}&list=PL123`));
    assert.throws(() => validateYouTubeUrl(`https://youtube.com/watch?v=${id}&feature=share`));
    assert.throws(() => validateYouTubeUrl(`https://youtu.be/${id}/extra`));
});

test("rejects malformed IDs and oversized URLs", () => {
    assert.throws(() => validateYouTubeUrl("https://youtube.com/watch?v=short"));
    assert.throws(() => validateYouTubeUrl(`https://youtube.com/watch?v=${id}${"x".repeat(2048)}`));
});
