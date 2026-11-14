import path from "node:path";
import { writeSync } from "node:fs";
import { execPath } from "node:process";
import { runYtDlpDownload } from "../../src/services/download-process.js";

const [root, mediaBinDir, fakeYtdlpPath, shutdownTimeout, hangShutdown, ignoreTerm] = process.argv.slice(2);
process.env.DOTENV_CONFIG_PATH = path.join(root, "empty.env");
process.env.API_KEY = "phase6-isolated-bootstrap-dummy-key-only";
process.env.YTDLP_PATH = execPath;
process.env.YTDLP_COOKIES_PATH = path.join(root, "cookies.fixture");
process.env.FFMPEG_PATH = mediaBinDir;
process.env.FFPROBE_PATH = path.join(mediaBinDir, `ffprobe${process.platform === "win32" ? ".exe" : ""}`);
process.env.STORAGE_PATH = path.join(root, "storage", "downloads");
process.env.LOG_PATH = path.join(root, "logs");
process.env.DOWNLOAD_CONCURRENCY = "1";
process.env.MAX_QUEUE_SIZE = "10";
process.env.MAX_FILE_SIZE = "1048576";
process.env.MAX_VIDEO_DURATION = "60";
process.env.FILE_TTL_MINUTES = "60";
process.env.SHUTDOWN_TIMEOUT_MS = String(shutdownTimeout);
process.env.PHASE6_PID_FILE = path.join(root, "fake-downloader.pid");
process.env.PHASE6_IGNORE_TERM = ignoreTerm === "true" ? "1" : "0";

try {
    const [{ default: config }, manager, store, { startApiServer }] = await Promise.all([
        import("../../src/config.js"),
        import("../../src/services/download-manager.js"),
        import("../../src/services/job-store.js"),
        import("../../src/server-bootstrap.js")
    ]);
    manager.setDownloadProcessRunner(({ args, signal, onProgress }) => runYtDlpDownload({
        binary: execPath,
        args: [fakeYtdlpPath, "--", ...args],
        signal,
        timeoutMs: 30_000,
        onProgress
    }));
    if (hangShutdown === "true") manager.shutdownDownloadManager = () => new Promise(() => {});
    const runtime = await startApiServer({
        config: { ...config, host: "127.0.0.1", port: 0, shutdownTimeoutMs: Number(shutdownTimeout) },
        manager,
        store,
        getVideoInfo: async () => ({ id: "abcdefghijk" }),
        getVideoFormats: async () => ({ formats: { video: [], audio: [] } }),
        logger: false,
        onShutdownTimeout: () => {
            writeSync(1, `${JSON.stringify({ type: "shutdown-deadline" })}\n`);
            process.exit(42);
        }
    });
    writeSync(1, `${JSON.stringify({ type: "ready", port: runtime.address.port })}\n`);
} catch (error) {
    writeSync(1, `${JSON.stringify({ type: "startup-error", code: error.code ?? "STARTUP_FAILED" })}\n`);
    process.exitCode = 2;
}
