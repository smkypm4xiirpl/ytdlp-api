import { AppError } from "../utils/errors.js";
import { runManagedProcess } from "./managed-process.js";

const MAX_MARKER_OUTPUT = 64 * 1024;
const MAX_ERROR_OUTPUT = 32 * 1024;

export function downloadTimeoutMs(maxDurationSeconds) {
    const calculated = maxDurationSeconds * 1000 + 10 * 60 * 1000;
    return Math.min(Math.max(calculated, 30 * 60 * 1000), 6 * 60 * 60 * 1000);
}

export async function runYtDlpDownload({ binary, args, signal, timeoutMs, onProgress, onSpawn }) {
    let output = "";
    let stderrRemainder = "";
    try {
        await runManagedProcess(binary, args, {
            signal,
            timeoutMs,
            maxStdoutBytes: MAX_MARKER_OUTPUT,
            maxStderrBytes: MAX_ERROR_OUTPUT,
            onSpawn,
            onStdout(chunk) { output += chunk; },
            onStderr(chunk) {
                const parts = (stderrRemainder + chunk).split(/\r?\n/);
                stderrRemainder = parts.pop()?.slice(-4096) ?? "";
                for (const line of parts) onProgress?.(line);
            }
        });
    } catch (error) {
        const errors = {
            PROCESS_CANCELLED: [409, "DOWNLOAD_CANCELLED", "Download cancelled"],
            PROCESS_TIMEOUT: [504, "YTDLP_TIMEOUT", "Download process timed out"],
            PROCESS_OUTPUT_LIMIT: [502, "YTDLP_OUTPUT_TOO_LARGE", "yt-dlp output exceeded the allowed size"],
            PROCESS_START_FAILED: [500, "YTDLP_START_FAILED", "Unable to start yt-dlp"],
            PROCESS_EXIT_NONZERO: [422, "DOWNLOAD_FAILED", "Download failed. The selected format may be unavailable or incompatible."],
            PROCESS_CALLBACK_FAILED: [500, "YTDLP_CALLBACK_FAILED", "Unable to process download progress"]
        };
        const [status, code, message] = errors[error.code] ?? [500, "YTDLP_PROCESS_FAILED", "yt-dlp process failed"];
        throw new AppError(message, status, code);
    }

    for (const line of stderrRemainder.split(/\r?\n/)) onProgress?.(line);
    const fileLine = output.split(/\r?\n/).find((line) => line.startsWith("__YTDLP_FILE__"));
    const filePath = fileLine?.slice("__YTDLP_FILE__".length).trim();
    if (!filePath) throw new AppError("Download completed but output file was not reported", 500, "OUTPUT_FILE_NOT_FOUND");
    return filePath;
}
