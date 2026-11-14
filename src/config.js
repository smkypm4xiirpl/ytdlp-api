import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

function required(name) {
    const value = process.env[name]?.trim();

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

function numberEnv(name, fallback, min, max) {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}`);
    }

    return value;
}

const apiKey = required("API_KEY");

if (Buffer.byteLength(apiKey, "utf8") < 32) {
    throw new Error("API_KEY must contain at least 32 bytes");
}

const config = {
    nodeEnv: process.env.NODE_ENV || "production",

    host: process.env.HOST || "127.0.0.1",
    port: numberEnv("PORT", 3100, 1, 65535),

    apiKey,

    ytdlpPath: required("YTDLP_PATH"),
    ytdlpCookiesPath: required("YTDLP_COOKIES_PATH"),
    ffmpegPath: required("FFMPEG_PATH"),
    ffprobePath: required("FFPROBE_PATH"),

    storagePath: path.resolve(required("STORAGE_PATH")),
    logPath: path.resolve(required("LOG_PATH")),

    downloadConcurrency: numberEnv("DOWNLOAD_CONCURRENCY", 2, 1, 10),
    maxQueueSize: numberEnv("MAX_QUEUE_SIZE", 30, 1, 1000),

    maxFileSize: numberEnv("MAX_FILE_SIZE", 8589934592, 1, Number.MAX_SAFE_INTEGER),
    maxVideoDuration: numberEnv("MAX_VIDEO_DURATION", 14400, 1, 86400),

    fileTtlMinutes: numberEnv("FILE_TTL_MINUTES", 60, 1, 10080),
    shutdownTimeoutMs: numberEnv("SHUTDOWN_TIMEOUT_MS", 30000, 1000, 120000)
};

for (const [name, filePath] of [
    ["yt-dlp", config.ytdlpPath],
    ["ffmpeg", path.join(config.ffmpegPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")],
    ["ffprobe", config.ffprobePath]
]) {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
    } catch {
        throw new Error(`${name} executable is missing or not executable: ${filePath}`);
    }
}

try {
    fs.accessSync(config.ytdlpCookiesPath, fs.constants.R_OK);
} catch {
    throw new Error(`YouTube cookies file is missing or unreadable: ${config.ytdlpCookiesPath}`);
}

fs.mkdirSync(config.storagePath, { recursive: true });
fs.mkdirSync(config.logPath, { recursive: true });

export default Object.freeze(config);
