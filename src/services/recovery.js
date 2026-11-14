import fs from "node:fs/promises";
import path from "node:path";
import { verifyMediaOutput } from "./media-policy.js";

const RECOVERABLE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(mp4|mkv|mp3)$/i;
const ACTIVE_STATES = new Set(["queued", "downloading", "processing"]);
const VALID_STATES = new Set(["queued", "downloading", "processing", "completed", "failed", "cancelled", "interrupted"]);
const VALID_OUTPUTS = new Set(["mp4", "mkv", "mp3"]);

export async function recoverDownloadJobs({ storedJobs, storagePath, maxFileSize, probe, persist, now = () => new Date() }) {
    const jobs = new Map();
    for (const stored of storedJobs) {
        const job = { ...stored, url: null, abortController: new AbortController() };
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.id) || !VALID_OUTPUTS.has(job.output) || !VALID_STATES.has(job.status)) {
            job.status = "failed";
            job.fileName = null;
            job.fileSize = null;
            job.error = { code: "INVALID_STORED_JOB", message: "Stored job metadata is invalid" };
            job.completedAt = now().toISOString();
            jobs.set(job.id, job);
            persist(job);
            continue;
        }
        if (ACTIVE_STATES.has(job.status)) {
            job.status = "interrupted";
            job.progress = Math.min(job.progress ?? 0, 99.99);
            job.error = { code: "SERVER_RESTARTED", message: "The server restarted before this download finished" };
            job.completedAt = now().toISOString();
        }
        if (job.status === "completed") {
            const expectedName = `${job.id}.${job.output}`;
            try {
                const outputPath = path.join(storagePath, expectedName);
                const stats = await fs.lstat(outputPath);
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxFileSize) throw new Error("Invalid output file");
                verifyMediaOutput(job.output, await probe(outputPath));
                job.fileName = expectedName;
                job.fileSize = stats.size;
            } catch {
                job.status = "failed";
                job.fileName = null;
                job.fileSize = null;
                job.error = { code: "RECOVERED_FILE_INVALID", message: "Previously completed file is missing or invalid" };
                job.completedAt = now().toISOString();
            }
        }
        jobs.set(job.id, job);
        persist(job);
    }

    // Only recognizable final UUID outputs are candidates. Temp/unrecognized files are untouched.
    for (const entry of await fs.readdir(storagePath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(RECOVERABLE);
        if (!match || jobs.has(match[1])) continue;
        const output = match[2].toLowerCase();
        const filePath = path.join(storagePath, entry.name);
        try {
            const stats = await fs.lstat(filePath);
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maxFileSize) continue;
            verifyMediaOutput(output, await probe(filePath));
            const created = now();
            const job = {
                id: match[1], videoId: "unknown", formatId: "recovered", output,
                status: "completed", progress: 100, downloadedBytes: stats.size,
                totalBytes: stats.size, speed: null, eta: 0, fileName: entry.name,
                fileSize: stats.size, error: null, createdAt: stats.mtime.toISOString(),
                startedAt: null, completedAt: created.toISOString(), url: null,
                abortController: new AbortController()
            };
            jobs.set(job.id, job);
            persist(job);
        } catch {
            // Leave invalid orphan files untouched for operator inspection.
        }
    }
    return jobs;
}
