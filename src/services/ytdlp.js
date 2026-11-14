import config from "../config.js";
import { AppError } from "../utils/errors.js";
import { validateYouTubeUrl } from "../utils/validation.js";
import { runManagedProcess } from "./managed-process.js";

const INFO_TIMEOUT_MS = 60_000;
const MAX_STDOUT_SIZE = 8 * 1024 * 1024;
const MAX_STDERR_SIZE = 32 * 1024;

function runYtDlp(args, timeoutMs = INFO_TIMEOUT_MS) {
    return runManagedProcess(config.ytdlpPath, args, {
        timeoutMs,
        maxStdoutBytes: MAX_STDOUT_SIZE,
        maxStderrBytes: MAX_STDERR_SIZE
    }).then(({ stdout }) => stdout).catch((error) => {
        if (error.code === "PROCESS_TIMEOUT") {
            throw new AppError("YouTube request timed out", 504, "YTDLP_TIMEOUT");
        }
        if (error.code === "PROCESS_OUTPUT_LIMIT") {
            throw new AppError("yt-dlp output exceeded the allowed size", 502, "YTDLP_OUTPUT_TOO_LARGE");
        }
        if (error.code === "PROCESS_START_FAILED") {
            throw new AppError("Unable to start yt-dlp", 500, "YTDLP_START_FAILED");
        }
        throw new AppError(
            "Unable to retrieve this YouTube video. It may be private, unavailable, or restricted.",
            422,
            "VIDEO_UNAVAILABLE"
        );
    });
}

async function getVideoMetadata(inputUrl) {
    const { url, videoId } = validateYouTubeUrl(inputUrl);

    const output = await runYtDlp([
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--js-runtimes", "node",
        "--cookies", config.ytdlpCookiesPath,
        "--ffmpeg-location", config.ffmpegPath,
        "--socket-timeout", "20",
        url
    ]);

    let metadata;

    try {
        metadata = JSON.parse(output);
    } catch {
        throw new AppError(
            "yt-dlp returned invalid metadata",
            502,
            "INVALID_YTDLP_RESPONSE"
        );
    }

    return {
        metadata,
        url,
        videoId
    };
}

export async function getVideoInfo(inputUrl) {
    const { metadata, url, videoId } =
        await getVideoMetadata(inputUrl);

    const uploadDate = metadata.upload_date;

    return {
        id: metadata.id || videoId,
        title: metadata.title || null,
        description: metadata.description
            ? metadata.description.slice(0, 5000)
            : null,
        duration: metadata.duration ?? null,
        durationString: metadata.duration_string ?? null,
        thumbnail: metadata.thumbnail ?? null,
        channel: metadata.channel ?? metadata.uploader ?? null,
        channelId: metadata.channel_id ?? metadata.uploader_id ?? null,
        uploader: metadata.uploader ?? null,
        viewCount: metadata.view_count ?? null,
        likeCount: metadata.like_count ?? null,
        uploadDate:
            typeof uploadDate === "string" &&
            /^\d{8}$/.test(uploadDate)
                ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
                : null,
        webpageUrl: metadata.webpage_url || url,
        extractor: metadata.extractor ?? null
    };
}

function normalizeFormat(format) {
    return {
        formatId: String(format.format_id),
        ext: format.ext ?? null,
        resolution: format.resolution ?? null,
        width: format.width ?? null,
        height: format.height ?? null,
        fps: format.fps ?? null,
        filesize: format.filesize ?? null,
        filesizeApprox: format.filesize_approx ?? null,
        formatNote: format.format_note ?? null,
        videoCodec: format.vcodec ?? null,
        audioCodec: format.acodec ?? null,
        bitrateKbps: format.tbr ?? null,
        videoBitrateKbps: format.vbr ?? null,
        audioBitrateKbps: format.abr ?? null,
        audioSampleRate: format.asr ?? null,
        audioChannels: format.audio_channels ?? null,
        dynamicRange: format.dynamic_range ?? null,
        hasDRM: format.has_drm ?? false
    };
}

export async function getVideoFormats(inputUrl) {
    const { metadata, videoId } =
        await getVideoMetadata(inputUrl);

    if (!Array.isArray(metadata.formats)) {
        throw new AppError(
            "No format information was returned by yt-dlp",
            502,
            "FORMATS_NOT_AVAILABLE"
        );
    }

    const videoFormats = [];
    const audioFormats = [];

    for (const format of metadata.formats) {
        if (!format.format_id) continue;

        const hasVideo =
            Boolean(format.vcodec) && format.vcodec !== "none";

        const hasAudio =
            Boolean(format.acodec) && format.acodec !== "none";

        if (hasVideo) {
            videoFormats.push(normalizeFormat(format));
        } else if (hasAudio) {
            audioFormats.push(normalizeFormat(format));
        }
    }

    videoFormats.sort((a, b) => {
        const heightDifference = (b.height ?? 0) - (a.height ?? 0);

        if (heightDifference !== 0) {
            return heightDifference;
        }

        return (b.fps ?? 0) - (a.fps ?? 0);
    });

    audioFormats.sort((a, b) => {
        return (b.audioBitrateKbps ?? 0) -
            (a.audioBitrateKbps ?? 0);
    });

    return {
        videoId: metadata.id || videoId,
        title: metadata.title ?? null,
        duration: metadata.duration ?? null,
        thumbnail: metadata.thumbnail ?? null,
        formatCount: {
            video: videoFormats.length,
            audio: audioFormats.length
        },
        formats: {
            video: videoFormats.slice(0, 200),
            audio: audioFormats.slice(0, 200)
        }
    };
}
