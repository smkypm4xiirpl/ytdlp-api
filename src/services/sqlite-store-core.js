import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function openSqliteJobStore(databasePath, { lock = true, lockPath = `${databasePath}.lock`, busyTimeoutMs = 5000 } = {}) {
    let lockFd;
    if (lock) {
        try {
            lockFd = fs.openSync(lockPath, "wx", 0o600);
            fs.writeFileSync(lockFd, `${process.pid}\n`);
            fs.fsyncSync(lockFd);
        } catch (error) {
            if (lockFd !== undefined) fs.closeSync(lockFd);
            if (error.code === "EEXIST") throw Object.assign(new Error("Another API instance owns the storage lock"), { code: "INSTANCE_LOCKED" });
            throw error;
        }
    }

    let db;
    let lockReleased = false;
    try {
        db = new DatabaseSync(databasePath);
        if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) throw new Error("Invalid SQLite busy timeout");
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${busyTimeoutMs};
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, video_id TEXT NOT NULL, format_id TEXT NOT NULL, output TEXT NOT NULL,
                status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, downloaded_bytes REAL, total_bytes REAL,
                speed REAL, eta REAL, file_name TEXT, file_size REAL, error_json TEXT,
                created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);`);
    } catch (error) {
        if (db?.isOpen) db.close();
        if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lockPath); }
        throw error;
    }

    const save = db.prepare(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET video_id=excluded.video_id, format_id=excluded.format_id, output=excluded.output,
        status=excluded.status, progress=excluded.progress, downloaded_bytes=excluded.downloaded_bytes,
        total_bytes=excluded.total_bytes, speed=excluded.speed, eta=excluded.eta, file_name=excluded.file_name,
        file_size=excluded.file_size, error_json=excluded.error_json, started_at=excluded.started_at, completed_at=excluded.completed_at`);
    const get = db.prepare("SELECT * FROM jobs WHERE id=?");
    const list = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC");
    const remove = db.prepare("DELETE FROM jobs WHERE id=?");
    const decode = row => {
        if (!row) return undefined;
        let error = null;
        if (row.error_json) {
            try { error = JSON.parse(row.error_json); }
            catch { error = { code: "INVALID_STORED_ERROR", message: "Stored error data is invalid" }; }
        }
        return { id: row.id, videoId: row.video_id, formatId: row.format_id, output: row.output,
            status: row.status, progress: row.progress, downloadedBytes: row.downloaded_bytes, totalBytes: row.total_bytes,
            speed: row.speed, eta: row.eta, fileName: row.file_name, fileSize: row.file_size,
            error, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at };
    };

    return {
        database: db,
        saveJob(job) { save.run(job.id, job.videoId, job.formatId, job.output, job.status, job.progress ?? 0,
            job.downloadedBytes ?? null, job.totalBytes ?? null, job.speed ?? null, job.eta ?? null,
            job.fileName ?? null, job.fileSize ?? null, job.error ? JSON.stringify(job.error) : null,
            job.createdAt, job.startedAt ?? null, job.completedAt ?? null); },
        getStoredJob(id) { return decode(get.get(id)); },
        listStoredJobs() { return list.all().map(decode); },
        deleteStoredJob(id) { remove.run(id); },
        close() {
            if (db.isOpen) db.close();
            if (lockFd !== undefined && !lockReleased) {
                lockReleased = true;
                fs.closeSync(lockFd);
                fs.unlinkSync(lockPath);
            }
        }
    };
}
