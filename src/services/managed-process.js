import { spawn } from "node:child_process";

const children = new Set();

export function terminateChild(child, graceMs = 1500) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessTree(child, false);
    const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
            signalProcessTree(child, true);
        }
    }, graceMs);
    escalation.unref?.();
    child.once("close", () => clearTimeout(escalation));
}

function signalProcessTree(child, force) {
    if (!child.pid) return;
    if (process.platform === "win32") {
        const args = ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])];
        const killer = spawn("taskkill.exe", args, { shell: false, windowsHide: true, stdio: "ignore" });
        killer.once("error", () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} });
        return;
    }
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
    catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
}

export function stopManagedChildren({ force = false } = {}) {
    for (const child of children) {
        if (force) signalProcessTree(child, true);
        else terminateChild(child);
    }
}

export function runManagedProcess(binary, args, options = {}) {
    const {
        timeoutMs = 60_000,
        maxStdoutBytes = 8 * 1024 * 1024,
        maxStderrBytes = 32 * 1024,
        signal,
        cwd,
        stdio = ["ignore", "pipe", "pipe"],
        onStdout,
        onStderr,
        onSpawn
    } = options;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(Object.assign(new Error("Process cancelled"), { code: "PROCESS_CANCELLED" }));
            return;
        }

        let child;
        try {
            child = spawn(binary, args, { shell: false, windowsHide: true, stdio, cwd, detached: process.platform !== "win32" });
        } catch (error) {
            reject(Object.assign(new Error("Unable to start child process"), { code: "PROCESS_START_FAILED", cause: error }));
            return;
        }
        children.add(child);
        try { onSpawn?.(child.pid); } catch {}
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let failure = null;
        let settled = false;
        let escalation;
        let escalationFired = false;
        let parentClosed = false;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (escalation) clearTimeout(escalation);
            signal?.removeEventListener("abort", onAbort);
            children.delete(child);
            error ? reject(error) : resolve(result);
        };
        const stop = (code, message) => {
            if (failure) return;
            failure = Object.assign(new Error(message), { code });
            signalProcessTree(child, false);
            escalation = setTimeout(() => {
                escalationFired = true;
                if (process.platform !== "win32" || (child.exitCode === null && child.signalCode === null)) {
                    signalProcessTree(child, true);
                }
                if (parentClosed) setImmediate(() => finish(failure));
            }, 1500);
            escalation.unref?.();
        };
        const onAbort = () => stop("PROCESS_CANCELLED", "Process cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
        const timeout = setTimeout(() => stop("PROCESS_TIMEOUT", "Child process timed out"), timeoutMs);
        timeout.unref?.();

        child.once("error", (error) => {
            finish(Object.assign(new Error("Unable to start child process"), { code: "PROCESS_START_FAILED", cause: error }));
        });
        child.stdout?.on("data", (chunk) => {
            if (stdout.length + chunk.length > maxStdoutBytes) {
                stop("PROCESS_OUTPUT_LIMIT", "Child process output limit exceeded");
                return;
            }
            stdout = Buffer.concat([stdout, chunk]);
            try { onStdout?.(chunk.toString("utf8")); } catch (error) { stop("PROCESS_CALLBACK_FAILED", "Child output callback failed"); }
        });
        child.stderr?.on("data", (chunk) => {
            if (stderr.length < maxStderrBytes) {
                stderr = Buffer.concat([stderr, chunk.subarray(0, maxStderrBytes - stderr.length)]);
            }
            try { onStderr?.(chunk.toString("utf8")); } catch { stop("PROCESS_CALLBACK_FAILED", "Child error callback failed"); }
        });
        child.once("close", (code, signalName) => {
            if (failure) {
                parentClosed = true;
                // A process group outlives its leader. Keep the escalation
                // timer armed if descendants remain, even when the parent has
                // already closed, so TERM-resistant children cannot orphan.
                if (process.platform !== "win32" && !escalationFired && processGroupExists(child.pid)) return;
                return finish(failure);
            }
            if (code !== 0) return finish(Object.assign(new Error("Child process failed"), { code: "PROCESS_EXIT_NONZERO", exitCode: code, signal: signalName, stderr: stderr.toString("utf8") }));
            finish(null, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
        });
    });
}

function processGroupExists(pgid) {
    if (!pgid) return false;
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}
