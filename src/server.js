import config from "./config.js";
import * as manager from "./services/download-manager.js";
import * as store from "./services/job-store.js";
import { getVideoInfo, getVideoFormats } from "./services/ytdlp.js";
import { startApiServer } from "./server-bootstrap.js";

try {
    const runtime = await startApiServer({
        config,
        manager,
        store,
        getVideoInfo,
        getVideoFormats,
        logger: config.nodeEnv === "production"
    });
    runtime.app.log.info(`YTDLP API listening on ${config.host}:${runtime.address.port}`);
} catch (error) {
    console.error("Unable to start or run YTDLP API", error.message);
    process.exitCode = 1;
}
