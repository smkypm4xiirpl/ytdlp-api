import test from "node:test";
import assert from "node:assert/strict";
import { assertMp4VideoCompatible } from "../src/services/media-policy.js";

test("MP4 policy accepts H.264 and explicitly rejects VP9/AV1/no video", () => {
    assert.doesNotThrow(() => assertMp4VideoCompatible([{ codec_type: "video", codec_name: "h264" }]));
    for (const codec_name of ["vp9", "av1"]) {
        assert.throws(() => assertMp4VideoCompatible([{ codec_type: "video", codec_name }]), (error) => error.code === "MP4_VIDEO_CODEC_UNSUPPORTED");
    }
    assert.throws(() => assertMp4VideoCompatible([{ codec_type: "audio", codec_name: "aac" }]), (error) => error.code === "VIDEO_STREAM_REQUIRED");
});
