import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

import { JobQueue } from "./job-queue.js";

import config from "../config.js";
import { AppError } from "../utils/errors.js";
import { validateYouTubeUrl } from "../utils/validation.js";
import { runManagedProcess } from "./managed-process.js";
import { assertMp4VideoCompatible, verifyMediaOutput } from "./media-policy.js";
import { runYtDlpDownload, downloadTimeoutMs } from "./download-process.js";
import { recoverDownloadJobs } from "./recovery.js";
import {
    saveJob,
    listStoredJobs,
    deleteStoredJob
} from "./job-store.js";

const queue = new JobQueue(config.downloadConcurrency);

const jobs = new Map();
let downloadProcessRunner = runYtDlpDownload;
let mediaProcessRunner = runManagedProcess;
let outputRenamer = (source, destination) => fs.rename(source, destination);
let storageStats = (storagePath) => fs.statfs(storagePath);

// Injectable process boundary for isolated integration tests. Production defaults
// to the real managed yt-dlp runner; this is not exposed through the API.
export function setDownloadProcessRunner(runner) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    downloadProcessRunner = runner;
}

export function setMediaProcessRunner(runner) {
    if (typeof runner !== "function") throw new TypeError("runner must be a function");
    mediaProcessRunner = runner;
}

export function setDownloadFileSystemHooks({ renameOutput, statfs } = {}) {
    outputRenamer = renameOutput ?? ((source, destination) => fs.rename(source, destination));
    storageStats = statfs ?? ((storagePath) => fs.statfs(storagePath));
}

function persistJob(job, { required = false } = {}) {
    try {
        saveJob(job);
        return true;
    } catch (error) {
        console.error(`Failed to persist download job ${job.id}:`, error.message);
        if (required) throw new AppError("Unable to persist download job", 503, "JOB_PERSISTENCE_FAILED");
        return false;
    }
}

function persistProgress(job) {
    const now = Date.now();

    // Persist progress at most once per second.
    if (now - (job.lastPersistAt ?? 0) >= 1000) {
        job.lastPersistAt = now;
        persistJob(job);
    }
}

/**
 * Restore persisted jobs and discover completed files that predate
 * SQLite persistence.
 */
export async function initializeDownloadManager() {
    const recovered = await recoverDownloadJobs({
        storedJobs: listStoredJobs(),
        storagePath: config.storagePath,
        maxFileSize: config.maxFileSize,
        probe: (filePath) => probeMedia(filePath, new AbortController().signal),
        persist: (job) => persistJob(job, { required: true })
    });
    jobs.clear();
    for (const [id, job] of recovered) jobs.set(id, job);
    console.log(`Restored ${jobs.size} download job(s) from storage`);
}

const FORMAT_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const OUTPUT_FORMATS = new Set(["mp4", "mkv", "mp3"]);

function publicJob(job) {
    return {
        id: job.id,
        videoId: job.videoId,
        formatId: job.formatId,
        output: job.output,
        status: job.status,
        progress: job.progress,
        downloadedBytes: job.downloadedBytes,
        totalBytes: job.totalBytes,
        speed: job.speed,
        eta: job.eta,
        fileName: job.fileName,
        fileSize: job.fileSize,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt
    };
}

function parseNumber(value) {
    if (!value || value === "NA") return null;

    const number = Number(value);

    return Number.isFinite(number) && number >= 0
        ? number
        : null;
}

function updateProgress(job, line) {
    const marker = "__YTDLP_PROGRESS__";
    const markerIndex = line.indexOf(marker);

    if (markerIndex !== -1) {
        const values = line
            .slice(markerIndex + marker.length)
            .trim()
            .split("|");

        const [
            downloaded,
            total,
            estimatedTotal,
            eta,
            speed
        ] = values;

        job.downloadedBytes = parseNumber(downloaded);

        job.totalBytes =
            parseNumber(total) ??
            parseNumber(estimatedTotal);

        job.eta = parseNumber(eta);
        job.speed = parseNumber(speed);

        if (job.totalBytes > 0 && job.downloadedBytes !== null) {
            job.progress = Math.min(
                99.99,
                Number(
                    (
                        job.downloadedBytes /
                        job.totalBytes *
                        100
                    ).toFixed(2)
                )
            );
        }

        persistProgress(job);
        return;
    }

    if (
        line.includes("[Merger]") ||
        line.includes("[ExtractAudio]") ||
        line.includes("[VideoRemuxer]")
    ) {
        if (job.status !== "processing") {
            job.status = "processing";
            persistJob(job);
        }
    }
}

function buildYtDlpArgs(job) {
    const outputTemplate = path.join(
        config.storagePath,
        `${job.id}.%(ext)s`
    );

    const args = [
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--progress-template",
        "download:__YTDLP_PROGRESS__%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.eta)s|%(progress.speed)s",
        "--print",
        "after_move:__YTDLP_FILE__%(filepath)s",
        "--no-simulate",
        "--no-overwrites",
        "--max-filesize",
        String(config.maxFileSize),
        "--match-filter",
        `duration <= ${config.maxVideoDuration}`,
        "--js-runtimes",
        "node",
        "--cookies",
        config.ytdlpCookiesPath,
        "--ffmpeg-location",
        config.ffmpegPath,
        "--socket-timeout",
        "20",
        "--output",
        outputTemplate
    ];

    if (job.output === "mp3") {
        args.push(
            "--format",
            job.formatId,
            "--extract-audio",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "0"
        );
    } else {
        args.push(
            "--format",
            `${job.formatId}+bestaudio/${job.formatId}`,
            "--merge-output-format",
            job.output,
            "--remux-video",
            job.output
        );
    }

    args.push(job.url);

    return args;
}


function probeMedia(filePath, signal) {
    return mediaProcessRunner(config.ffprobePath, [
        "-v", "error", "-show_entries", "format=format_name:stream=codec_type,codec_name,profile",
        "-of", "json", filePath
    ], { signal, timeoutMs: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 8 * 1024 })
        .then(({ stdout }) => {
            const result = JSON.parse(stdout);
            if (!Array.isArray(result.streams)) throw new Error("Invalid FFprobe streams");
            return result;
        })
        .catch((error) => {
            if (error.code === "PROCESS_CANCELLED") throw new AppError("Download cancelled", 409, "DOWNLOAD_CANCELLED");
            if (error.code === "PROCESS_TIMEOUT") throw new AppError("FFprobe timed out", 504, "FFPROBE_TIMEOUT");
            if (error.code === "PROCESS_START_FAILED") throw new AppError("Unable to start FFprobe", 500, "FFPROBE_START_FAILED");
            if (error.code === "PROCESS_OUTPUT_LIMIT") throw new AppError("FFprobe output exceeded the allowed size", 500, "FFPROBE_OUTPUT_TOO_LARGE");
            if (error.code === "PROCESS_EXIT_NONZERO") throw new AppError("Unable to inspect media file", 422, "FFPROBE_FAILED");
            throw new AppError("FFprobe returned invalid output", 500, "FFPROBE_INVALID_OUTPUT");
        });
}

function convertMp4AudioToAac(job, inputPath, outputPath) {
    const args = [
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i", inputPath,

            "-map", "0:v?",
            "-map", "0:a?",

            "-map_metadata", "0",
            "-map_chapters", "0",

            "-c:v", "copy",
            "-c:a", job.copyAacAudio ? "copy" : "aac",
            ...(job.copyAacAudio ? [] : ["-profile:a", "aac_low", "-b:a", "256k"]),

            "-sn",
            "-dn",
            "-movflags", "+faststart",

            outputPath
    ];
    return mediaProcessRunner(path.join(config.ffmpegPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"), args, {
        signal: job.abortController.signal,
        timeoutMs: downloadTimeoutMs(config.maxVideoDuration),
        maxStdoutBytes: 1024,
        maxStderrBytes: 32 * 1024,
        stdio: "ignore"
    }).catch((error) => {
        if (error.code === "PROCESS_CANCELLED") throw new AppError("Download cancelled", 409, "DOWNLOAD_CANCELLED");
        if (error.code === "PROCESS_TIMEOUT") throw new AppError("FFmpeg processing timed out", 504, "FFMPEG_TIMEOUT");
        if (error.code === "PROCESS_START_FAILED") throw new AppError("Unable to start FFmpeg", 500, "FFMPEG_START_FAILED");
        if (error.code === "ENOSPC") throw new AppError("Storage ran out of space while FFmpeg was writing output", 507, "STORAGE_WRITE_FAILED");
        throw new AppError("FFmpeg could not convert MP4 audio to AAC", 422, "AAC_CONVERSION_FAILED");
    });
}

async function ensureMp4AudioCompatibility(job, filePath) {
    const signal = job.abortController.signal;

    job.status = "processing";
    job.progress = Math.min(job.progress ?? 0, 99);
    persistJob(job);

    const originalProbe = await probeMedia(filePath, signal);

    const originalAudioStreams = originalProbe.streams.filter(
        (stream) => stream.codec_type === "audio"
    );
    assertMp4VideoCompatible(originalProbe.streams);

    const temporaryPath = path.join(
        config.storagePath,
        `${job.id}.${randomUUID()}.processing.mp4`
    );

    try {
        // Advisory check on the volume that actually stores both input and temp output.
        // ENOSPC remains possible after this check and is handled as a process failure.
        if (typeof fs.statfs === "function") {
            const disk = await storageStats(config.storagePath);
            const freeBytes = Number(disk.bavail) * Number(disk.bsize);
            const inputStats = await fs.stat(filePath);
            if (Number.isFinite(freeBytes) && freeBytes < inputStats.size + 32 * 1024 * 1024) {
                throw new AppError("Insufficient free space on download storage for safe MP4 processing", 507, "INSUFFICIENT_STORAGE");
            }
        }
        job.copyAacAudio = originalAudioStreams.every((stream) => stream.codec_name === "aac" && stream.profile === "LC");

        await convertMp4AudioToAac(
            job,
            filePath,
            temporaryPath
        );

        if (signal.aborted) {
            throw new AppError(
                "Download cancelled",
                409,
                "DOWNLOAD_CANCELLED"
            );
        }

        const temporaryStats = await fs.lstat(temporaryPath);

        if (
            !temporaryStats.isFile() ||
            temporaryStats.isSymbolicLink()
        ) {
            throw new AppError(
                "FFmpeg did not produce a valid output file",
                500,
                "INVALID_CONVERTED_FILE"
            );
        }

        if (temporaryStats.size > config.maxFileSize) {
            throw new AppError(
                "Converted file exceeds the maximum allowed size",
                413,
                "FILE_TOO_LARGE"
            );
        }

        const convertedProbe = await probeMedia(
            temporaryPath,
            signal
        );

        const convertedAudioStreams = convertedProbe.streams.filter(
            (stream) => stream.codec_type === "audio"
        );

        if (
            convertedAudioStreams.length !== originalAudioStreams.length ||
            convertedAudioStreams.some(
                (stream) => stream.codec_name !== "aac"
            )
        ) {
            throw new AppError(
                "AAC audio verification failed",
                500,
                "AAC_VERIFICATION_FAILED"
            );
        }

        if (!convertedProbe.streams.some((stream) => stream.codec_type === "video")) {
            throw new AppError("MP4 output has no video stream", 500, "VIDEO_VERIFICATION_FAILED");
        }

        // Confirm that video streams were copied, not re-encoded.
        const originalVideoCodecs = originalProbe.streams
            .filter((stream) => stream.codec_type === "video")
            .map((stream) => stream.codec_name);

        const convertedVideoCodecs = convertedProbe.streams
            .filter((stream) => stream.codec_type === "video")
            .map((stream) => stream.codec_name);

        if (
            JSON.stringify(originalVideoCodecs) !==
            JSON.stringify(convertedVideoCodecs)
        ) {
            throw new AppError(
                "Video stream verification failed",
                500,
                "VIDEO_VERIFICATION_FAILED"
            );
        }

        // Both files are in the same directory. On Linux, rename
        // atomically replaces the original only after validation.
        try {
            await outputRenamer(temporaryPath, filePath);
        } catch (error) {
            throw new AppError("Unable to atomically replace MP4 output; original download was preserved", 507, "OUTPUT_RENAME_FAILED");
        }
    } finally {
        delete job.copyAacAudio;
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
}

function runDownloadProcess(job) {
    return downloadProcessRunner({
        binary: config.ytdlpPath,
        args: buildYtDlpArgs(job),
        signal: job.abortController.signal,
        timeoutMs: downloadTimeoutMs(config.maxVideoDuration),
        onProgress: (line) => updateProgress(job, line)
    });
}

async function executeDownload(job) {
    job.status = "downloading";
    job.startedAt = new Date().toISOString();
    persistJob(job);
    let artifactPath = null;
    let preserveArtifact = false;

    try {
        const filePath = await runDownloadProcess(job);

        if (job.abortController.signal.aborted) {
            throw new AppError(
                "Download cancelled",
                409,
                "DOWNLOAD_CANCELLED"
            );
        }

        const resolvedPath = path.resolve(filePath);
        artifactPath = resolvedPath;
        const storageRoot = path.resolve(config.storagePath);
        const expectedName = `${job.id}.${job.output}`;

        if (
            path.dirname(resolvedPath) !== storageRoot ||
            path.basename(resolvedPath) !== expectedName
        ) {
            throw new AppError(
                "Invalid output file path",
                500,
                "INVALID_OUTPUT_PATH"
            );
        }

        const stats = await fs.lstat(resolvedPath);

        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw new AppError(
                "Download output is not a regular file",
                500,
                "INVALID_OUTPUT_FILE"
            );
        }

        preserveArtifact = true;

        if (stats.size > config.maxFileSize) {
            preserveArtifact = false;
            await fs.rm(resolvedPath, { force: true });

            throw new AppError(
                "Downloaded file exceeds the maximum allowed size",
                413,
                "FILE_TOO_LARGE"
            );
        }

        // Convert only MP4 audio when it is not already AAC.
        if (job.output === "mp4") {
            await ensureMp4AudioCompatibility(job, resolvedPath);
        }

        if (job.abortController.signal.aborted) {
            throw new AppError(
                "Download cancelled",
                409,
                "DOWNLOAD_CANCELLED"
            );
        }

        // Validate the final file again after post-processing.
        const finalStats = await fs.lstat(resolvedPath);

        if (
            !finalStats.isFile() ||
            finalStats.isSymbolicLink()
        ) {
            throw new AppError(
                "Final output is not a regular file",
                500,
                "INVALID_OUTPUT_FILE"
            );
        }

        if (finalStats.size > config.maxFileSize) {
            preserveArtifact = false;
            await fs.rm(resolvedPath, { force: true });

            throw new AppError(
                "Final output exceeds the maximum allowed size",
                413,
                "FILE_TOO_LARGE"
            );
        }

        verifyMediaOutput(job.output, await probeMedia(resolvedPath, job.abortController.signal));

        const completedState = {
            ...job,
            status: "completed",
            progress: 100,
            fileName: expectedName,
            fileSize: finalStats.size,
            completedAt: new Date().toISOString()
        };
        // Persist a candidate snapshot first. The in-memory/API state remains
        // processing until SQLite confirms the terminal transition.
        persistJob(completedState, { required: true });
        Object.assign(job, completedState);
    } catch (error) {
        // A failed/cancelled artifact must never be rediscovered as a completed
        // orphan on the next startup. Remove only this job's exact output name.
        if (preserveArtifact && artifactPath) {
            try {
                const failedStats = await fs.lstat(artifactPath);
                if (failedStats.isFile() && !failedStats.isSymbolicLink()) {
                    const failedArtifact = path.join(config.storagePath, `${job.id}.${randomUUID()}.failed.${job.output}`);
                    await fs.rename(artifactPath, failedArtifact);
                }
            } catch (cleanupError) {
                if (cleanupError.code !== "ENOENT") {
                    console.error(`Failed to quarantine failed output for job ${job.id}:`, cleanupError.message);
                }
            }
        } else {
            const failedOutput = path.join(config.storagePath, `${job.id}.${job.output}`);
            await fs.rm(failedOutput, { force: true }).catch(cleanupError => {
                if (cleanupError.code !== "ENOENT") console.error(`Failed to remove incomplete output for job ${job.id}:`, cleanupError.message);
            });
        }

        if (job.abortController.signal.aborted) {
            job.status = "cancelled";
            job.error = null;
        } else {
            const storageWriteFailed = error.code === "ENOSPC";
            job.status = "failed";
            job.error = {
                code: storageWriteFailed ? "STORAGE_WRITE_FAILED" : error.code || "DOWNLOAD_FAILED",
                message: storageWriteFailed
                    ? "Storage ran out of space while processing the download"
                    : error.statusCode
                        ? error.message
                        : "Download failed due to an internal error"
            };
        }

        job.completedAt = new Date().toISOString();
        persistJob(job);
    }
}

export function createDownload(input) {
    const { url, videoId } = validateYouTubeUrl(input.url);

    if (
        typeof input.formatId !== "string" ||
        !FORMAT_ID_PATTERN.test(input.formatId)
    ) {
        throw new AppError(
            "Invalid formatId",
            400,
            "INVALID_FORMAT_ID"
        );
    }

    if (!OUTPUT_FORMATS.has(input.output)) {
        throw new AppError(
            "Output must be mp4, mkv, or mp3",
            400,
            "INVALID_OUTPUT_FORMAT"
        );
    }

    if (queue.size + queue.pending >= config.maxQueueSize) {
        throw new AppError(
            "Download queue is full. Please try again later.",
            429,
            "QUEUE_FULL"
        );
    }

    const id = randomUUID();

    const job = {
        id,
        videoId,
        url,
        formatId: input.formatId,
        output: input.output,

        status: "queued",
        progress: 0,
        downloadedBytes: 0,
        totalBytes: null,
        speed: null,
        eta: null,

        fileName: null,
        fileSize: null,
        error: null,

        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,

        abortController: new AbortController()
    };

    jobs.set(id, job);
    persistJob(job, { required: true });
    job.queuePending = true;
    const task = queue.add(
        () => executeDownload(job),
        {
            signal: job.abortController.signal
        }
    );

    task.catch((error) => {
        if (job.abortController.signal.aborted) {
            job.status = "cancelled";
            job.error = null;
        } else {
            job.status = "failed";
            job.error = {
                code: error.code || "QUEUE_ERROR",
                message: "Unable to process download job"
            };
        }

        job.completedAt = new Date().toISOString();
        persistJob(job);
    }).finally(() => { job.queuePending = false; });

    return publicJob(job);
}

export function getDownload(id) {
    const job = jobs.get(id);

    if (!job) {
        throw new AppError(
            "Download job not found",
            404,
            "JOB_NOT_FOUND"
        );
    }

    return publicJob(job);
}

export function listDownloads() {
    return [...jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(publicJob);
}

export async function shutdownDownloadManager() {
    for (const job of jobs.values()) {
        if (["queued", "downloading", "processing"].includes(job.status)) {
            job.abortController.abort();
        }
    }
    await queue.onIdle();
}

export function cancelDownload(id) {
    const job = jobs.get(id);

    if (!job) {
        throw new AppError(
            "Download job not found",
            404,
            "JOB_NOT_FOUND"
        );
    }

    if (
        ["completed", "failed", "cancelled", "interrupted"].includes(job.status)
    ) {
        throw new AppError(
            "Download job is already finished",
            409,
            "JOB_ALREADY_FINISHED"
        );
    }

    const wasQueued = job.status === "queued";
    job.abortController.abort();
    if (wasQueued) {
        // p-queue 8.1.1 keeps an aborted waiter in its internal queue until it
        // reaches the head, so expose the terminal state immediately.
        job.status = "cancelled";
        job.error = null;
        job.completedAt = new Date().toISOString();
        persistJob(job, { required: true });
    } else {
        persistJob(job);
    }

    return publicJob(job);
}

// Active file streams prevent cleanup while a client is downloading.
const activeFileStreams = new Map();
const deletingFiles = new Set();

function releaseFileStream(id) {
    const count = activeFileStreams.get(id) ?? 0;

    if (count <= 1) {
        activeFileStreams.delete(id);
    } else {
        activeFileStreams.set(id, count - 1);
    }
}

export async function acquireDownloadFile(id) {
    const job = jobs.get(id);

    if (!job) {
        throw new AppError(
            "Download job not found",
            404,
            "JOB_NOT_FOUND"
        );
    }

    if (job.status !== "completed" || !job.fileName) {
        throw new AppError(
            "Download file is not available yet",
            409,
            "FILE_NOT_READY"
        );
    }

    if (deletingFiles.has(id)) {
        throw new AppError(
            "Download file has expired",
            410,
            "FILE_EXPIRED"
        );
    }

    const expectedName = `${id}.${job.output}`;

    if (job.fileName !== expectedName) {
        throw new AppError(
            "Invalid download file",
            500,
            "INVALID_OUTPUT_PATH"
        );
    }

    activeFileStreams.set(
        id,
        (activeFileStreams.get(id) ?? 0) + 1
    );

    let released = false;

    const release = () => {
        if (released) return;
        released = true;
        releaseFileStream(id);
    };

    try {
        const storageRoot = await fs.realpath(config.storagePath);
        const filePath = path.resolve(storageRoot, job.fileName);

        if (path.dirname(filePath) !== storageRoot) {
            throw new AppError(
                "Invalid download file path",
                500,
                "INVALID_OUTPUT_PATH"
            );
        }

        const fileStats = await fs.lstat(filePath);

        if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
            throw new AppError(
                "Download output is not a regular file",
                500,
                "INVALID_OUTPUT_FILE"
            );
        }

        const realFilePath = await fs.realpath(filePath);

        if (!realFilePath.startsWith(storageRoot + path.sep)) {
            throw new AppError(
                "Invalid download file path",
                500,
                "INVALID_OUTPUT_PATH"
            );
        }

        return {
            filePath: realFilePath,
            fileName: job.fileName,
            fileSize: fileStats.size,
            release
        };
    } catch (error) {
        release();

        if (error.code === "ENOENT") {
            throw new AppError(
                "Download file no longer exists",
                404,
                "FILE_NOT_FOUND"
            );
        }

        throw error;
    }
}

export async function cleanupExpiredDownloads(now = Date.now()) {
    const ttlMs = config.fileTtlMinutes * 60 * 1000;

    for (const job of jobs.values()) {
        if (
            !["completed", "failed", "cancelled", "interrupted"].includes(job.status)
        ) {
            continue;
        }

        if (job.queuePending) continue;

        if (activeFileStreams.has(job.id)) {
            continue;
        }

        const referenceTime = Date.parse(
            job.completedAt ?? job.createdAt
        );

        if (!Number.isFinite(referenceTime)) {
            continue;
        }

        if (now - referenceTime < ttlMs) {
            continue;
        }

        if (deletingFiles.has(job.id)) {
            continue;
        }

        deletingFiles.add(job.id);

        try {
            const entries = await fs.readdir(config.storagePath, {
                withFileTypes: true
            });

            for (const entry of entries) {
                if (
                    entry.isFile() &&
                    entry.name.startsWith(`${job.id}.`)
                ) {
                    await fs.rm(
                        path.join(config.storagePath, entry.name),
                        { force: true }
                    );
                }
            }

            deleteStoredJob(job.id);
            jobs.delete(job.id);
        } catch (error) {
            console.error(
                `Failed to clean download job ${job.id}:`,
                error.message
            );
        } finally {
            deletingFiles.delete(job.id);
        }
    }
}
