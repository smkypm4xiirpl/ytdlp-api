import { badRequest } from "./errors.js";

const ALLOWED_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be"
]);

export function validateYouTubeUrl(input) {
    if (typeof input !== "string" || input.length > 2048) {
        throw badRequest("URL must be a string with a maximum length of 2048 characters", "INVALID_URL");
    }

    let parsed;

    try {
        parsed = new URL(input);
    } catch {
        throw badRequest("Invalid URL", "INVALID_URL");
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw badRequest("Only HTTP and HTTPS URLs are allowed", "INVALID_URL_PROTOCOL");
    }

    if (parsed.username || parsed.password) {
        throw badRequest("URL credentials are not allowed", "INVALID_URL");
    }

    if (parsed.port) {
        throw badRequest("Custom URL ports are not allowed", "INVALID_URL");
    }

    if (parsed.hash) {
        throw badRequest("URL fragments are not allowed", "INVALID_URL");
    }

    const hostname = parsed.hostname.toLowerCase();

    if (!ALLOWED_HOSTS.has(hostname)) {
        throw badRequest("Only supported YouTube URLs are allowed", "UNSUPPORTED_URL");
    }

    let videoId = null;

    if (hostname === "youtu.be") {
        if (parsed.pathname.split("/").filter(Boolean).length !== 1) {
            throw badRequest("URL must identify a single video", "INVALID_VIDEO_ID");
        }
        videoId = parsed.pathname.split("/").filter(Boolean)[0];
    } else if (parsed.pathname === "/watch") {
        videoId = parsed.searchParams.get("v");
        if ([...parsed.searchParams.keys()].some((key) => key !== "v")) {
            throw badRequest("Only a single video URL is supported", "INVALID_VIDEO_ID");
        }
    } else {
        const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
        videoId = match?.[1] ?? null;
        if (!match || parsed.pathname !== `/${parsed.pathname.split("/").filter(Boolean)[0]}/${videoId}` || parsed.search) {
            throw badRequest("Only a single video URL is supported", "INVALID_VIDEO_ID");
        }
    }

    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw badRequest("Could not identify a valid YouTube video ID", "INVALID_VIDEO_ID");
    }

    return {
        url: parsed.toString(),
        videoId
    };
}
