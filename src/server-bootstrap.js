import { buildApp } from "./app.js";
import { stopManagedChildren } from "./services/managed-process.js";
import { withTimeout } from "./utils/with-timeout.js";

export async function startApiServer({
    config,
    manager,
    store,
    getVideoInfo,
    getVideoFormats,
    logger = false,
    installSignalHandlers = true,
    stopChildren = stopManagedChildren,
    onShutdownTimeout = () => process.exit(1),
    processObject = process
}) {
    let app;
    let cleanupTimer;
    let closePromise;
    let signalHandlers;

    try {
        await manager.initializeDownloadManager();
        await manager.cleanupExpiredDownloads();

        app = await buildApp({
            apiKey: config.apiKey,
            manager,
            getVideoInfo,
            getVideoFormats,
            logger
        });

        app.addHook("onClose", async () => {
            clearInterval(cleanupTimer);
            try {
                await manager.shutdownDownloadManager();
                stopChildren();
                store.closeJobStore();
            } finally {
                if (signalHandlers) {
                    processObject.off("SIGINT", signalHandlers.sigint);
                    processObject.off("SIGTERM", signalHandlers.sigterm);
                }
            }
        });

        cleanupTimer = setInterval(() => {
            manager.cleanupExpiredDownloads().catch(error => app.log.error({ err: error }, "Download cleanup failed"));
        }, 5 * 60 * 1000);
        cleanupTimer.unref();

        await app.listen({ host: config.host, port: config.port });
    } catch (error) {
        clearInterval(cleanupTimer);
        if (app) {
            await app.close().catch(() => {});
        } else {
            store.closeJobStore();
        }
        throw error;
    }

    const shutdown = (signal = "requested") => {
        if (!closePromise) {
            app.log.info(`Received ${signal}, shutting down`);
            closePromise = withTimeout(
                () => app.close(),
                config.shutdownTimeoutMs,
                error => {
                    app.log.fatal({ timeoutMs: config.shutdownTimeoutMs }, "Shutdown deadline exceeded; terminating owned child processes");
                    stopChildren({ force: true });
                    onShutdownTimeout(error);
                }
            );
        }
        return closePromise;
    };

    if (installSignalHandlers) {
        signalHandlers = {
            sigint: () => { void shutdown("SIGINT").catch(error => { app.log.error({ err: error }, "Shutdown failed"); processObject.exitCode = 1; }); },
            sigterm: () => { void shutdown("SIGTERM").catch(error => { app.log.error({ err: error }, "Shutdown failed"); processObject.exitCode = 1; }); }
        };
        processObject.once("SIGINT", signalHandlers.sigint);
        processObject.once("SIGTERM", signalHandlers.sigterm);
    }

    return { app, address: app.server.address(), shutdown };
}
