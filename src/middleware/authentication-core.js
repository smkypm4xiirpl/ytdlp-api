import crypto from "node:crypto";

export function createAuthentication(apiKey) {
    return async function authentication(request, reply) {
        const pathname = request.url.split("?")[0];
        if (pathname === "/api/v1/health") return;
        const header = request.headers["x-api-key"];
        const authorization = request.headers.authorization;
        const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
            ? authorization.slice(7)
            : undefined;
        const supplied = header ?? bearer;
        if (typeof supplied !== "string") {
            return reply.code(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } });
        }
        const expected = Buffer.from(apiKey, "utf8");
        const received = Buffer.from(supplied, "utf8");
        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            return reply.code(401).send({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } });
        }
    };
}
