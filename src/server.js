import { assertSupportedNodeVersion } from "./runtime-requirements.js";

try {
    assertSupportedNodeVersion();
    const [configModule, manager, store, ytdlp, bootstrap] = await Promise.all([
        import("./config.js"),
        import("./services/download-manager.js"),
        import("./services/job-store.js"),
        import("./services/ytdlp.js"),
        import("./server-bootstrap.js")
    ]);
    const runtime = await bootstrap.startApiServer({
        config: configModule.default,
        manager,
        store,
        getVideoInfo: ytdlp.getVideoInfo,
        getVideoFormats: ytdlp.getVideoFormats,
        logger: configModule.default.nodeEnv === "production"
    });
    runtime.app.log.info(`YTDLP API listening on ${configModule.default.host}:${runtime.address.port}`);
} catch (error) {
    console.error("Unable to start or run YTDLP API", error.message);
    process.exitCode = 1;
}
