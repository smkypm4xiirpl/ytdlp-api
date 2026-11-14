export class AppError extends Error {
    constructor(message, statusCode = 500, code = "INTERNAL_ERROR") {
        super(message);

        this.name = "AppError";
        this.statusCode = statusCode;
        this.code = code;
    }
}

export function badRequest(message, code = "BAD_REQUEST") {
    return new AppError(message, 400, code);
}

export function unauthorized(message = "Invalid or missing API key") {
    return new AppError(message, 401, "UNAUTHORIZED");
}

export function notFound(message = "Resource not found") {
    return new AppError(message, 404, "NOT_FOUND");
}

export function tooManyRequests(message = "Too many requests") {
    return new AppError(message, 429, "RATE_LIMITED");
}
