import crypto from "node:crypto";
import config from "../config.js";
import { unauthorized } from "../utils/errors.js";

export async function authentication(request, reply) {
    const pathname = request.url.split("?")[0];

    // Health check sengaja dibuat publik.
    if (pathname === "/api/v1/health") {
        return;
    }

    const headerKey = request.headers["x-api-key"];

    const authorization = request.headers.authorization;
    const bearerKey = authorization?.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;

    const suppliedKey = headerKey ?? bearerKey;

    if (typeof suppliedKey !== "string") {
        throw unauthorized();
    }

    const expected = Buffer.from(config.apiKey, "utf8");
    const received = Buffer.from(suppliedKey, "utf8");

    if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
    ) {
        throw unauthorized();
    }
}
