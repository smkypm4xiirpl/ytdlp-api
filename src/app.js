import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { createAuthentication } from "./middleware/authentication-core.js";
import healthRoutes from "./routes/health.js";
import infoRoutes from "./routes/info.js";
import formatsRoutes from "./routes/formats.js";
import downloadRoutes from "./routes/downloads.js";

export async function buildApp({ apiKey, manager, getVideoInfo, getVideoFormats, logger = false, loggerInstance, globalRateLimit = 120 }) {
    const app = Fastify({
        logger: loggerInstance ? false : (logger ? { level: "info", redact: ["req.headers.x-api-key", "req.headers.authorization"] } : false),
        ...(loggerInstance ? { loggerInstance } : {}),
        ajv: { customOptions: { removeAdditional: false } },
        bodyLimit: 1024 * 1024,
        requestTimeout: 30_000
    });
    await app.register(rateLimit, { global: true, max: globalRateLimit, timeWindow: "1 minute" });
    app.addHook("onRequest", createAuthentication(apiKey));
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ success: false, error: { code: "ROUTE_NOT_FOUND", message: "API endpoint not found" } }));
    app.setErrorHandler((error, request, reply) => {
        if (error.statusCode === 429) {
            const full = error.code === "QUEUE_FULL";
            return reply.code(429).send({ success: false, error: { code: full ? "QUEUE_FULL" : "RATE_LIMITED", message: full ? error.message : "Too many requests" } });
        }
        if (error.statusCode >= 400 && error.statusCode < 500) {
            return reply.code(error.statusCode).send({ success: false, error: { code: error.code || "REQUEST_ERROR", message: error.message } });
        }
        request.log.error({ err: error }, "Request failed");
        return reply.code(500).send({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred" } });
    });
    await app.register(healthRoutes);
    await app.register(infoRoutes, { getVideoInfo });
    await app.register(formatsRoutes, { getVideoFormats });
    await app.register(downloadRoutes, { manager });
    return app;
}
