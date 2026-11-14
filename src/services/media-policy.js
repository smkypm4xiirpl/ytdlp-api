import { AppError } from "../utils/errors.js";

export function assertMp4VideoCompatible(streams) {
    const videos = streams.filter((stream) => stream.codec_type === "video");
    if (videos.length === 0) {
        throw new AppError("MP4 output must contain a video stream", 422, "VIDEO_STREAM_REQUIRED");
    }
    if (videos.some((stream) => !["h264", "avc"].includes(stream.codec_name))) {
        throw new AppError(
            "MP4 output requires H.264 video. Select an H.264 format or use MKV; video transcoding is not performed automatically.",
            422,
            "MP4_VIDEO_CODEC_UNSUPPORTED"
        );
    }
}

export function verifyMediaOutput(output, probe) {
    const streams = probe?.streams;
    const formats = probe?.format?.format_name?.split(",") ?? [];
    if (!Array.isArray(streams)) throw new AppError("Media streams could not be verified", 422, "INVALID_MEDIA_STREAMS");
    if (output === "mp4") {
        assertMp4VideoCompatible(streams);
        if (streams.some(stream => stream.codec_type === "audio" && (stream.codec_name !== "aac" || stream.profile !== "LC"))) {
            throw new AppError("Final MP4 audio must be AAC-LC", 422, "AAC_VERIFICATION_FAILED");
        }
        if (!formats.includes("mp4")) throw new AppError("Final file is not an MP4 container", 422, "OUTPUT_CONTAINER_MISMATCH");
    } else if (output === "mkv") {
        if (!formats.includes("matroska")) throw new AppError("Final file is not a Matroska container", 422, "OUTPUT_CONTAINER_MISMATCH");
        if (!streams.some(stream => ["audio", "video"].includes(stream.codec_type))) throw new AppError("MKV has no audio or video stream", 422, "INVALID_MEDIA_STREAMS");
    } else if (output === "mp3") {
        if (!formats.includes("mp3") || !streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "mp3") || streams.some(stream => stream.codec_type === "video")) {
            throw new AppError("Final output is not a valid MP3 audio file", 422, "OUTPUT_CONTAINER_MISMATCH");
        }
    } else {
        throw new AppError("Unsupported output format", 400, "INVALID_OUTPUT_FORMAT");
    }
}
