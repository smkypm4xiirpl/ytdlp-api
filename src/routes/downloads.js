import { createReadStream } from "node:fs";

const UUID_PATTERN =
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

const paramsSchema = {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
        id: {
            type: "string",
            pattern: UUID_PATTERN
        }
    }
};

const MIME_TYPES = {
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg"
};

function parseRange(rangeHeader, fileSize) {
    if (!rangeHeader) return null;

    if (fileSize <= 0 || rangeHeader.includes(",")) {
        return { invalid: true };
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

    if (!match || (!match[1] && !match[2])) {
        return { invalid: true };
    }

    let start;
    let end;

    if (!match[1]) {
        const suffixLength = Number(match[2]);

        if (
            !Number.isSafeInteger(suffixLength) ||
            suffixLength <= 0
        ) {
            return { invalid: true };
        }

        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : fileSize - 1;

        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            start >= fileSize
        ) {
            return { invalid: true };
        }

        end = Math.min(end, fileSize - 1);
    }

    return { start, end };
}

export default async function downloadRoutes(app, { manager }) {
    // Create download job
    app.post("/api/v1/downloads", {
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
        schema: {
            body: {
                type: "object",
                required: ["url", "formatId", "output"],
                additionalProperties: false,
                properties: {
                    url: {
                        type: "string",
                        minLength: 1,
                        maxLength: 2048
                    },
                    formatId: {
                        type: "string",
                        minLength: 1,
                        maxLength: 64
                    },
                    output: {
                        type: "string",
                        enum: ["mp4", "mkv", "mp3"]
                    }
                }
            }
        }
    }, async (request, reply) => {
        const job = manager.createDownload(request.body);

        return reply.code(202).send({
            success: true,
            message: "Download job created",
            data: job
        });
    });

    // List download jobs
    app.get("/api/v1/downloads", async () => {
        return {
            success: true,
            data: manager.listDownloads()
        };
    });

    // Get download job status
    app.get("/api/v1/downloads/:id", {
        schema: { params: paramsSchema }
    }, async (request) => {
        return {
            success: true,
            data: manager.getDownload(request.params.id)
        };
    });

    // Download completed file (supports HTTP Range)
    app.get("/api/v1/downloads/:id/file", {
        schema: { params: paramsSchema }
    }, async (request, reply) => {
        const file = await manager.acquireDownloadFile(request.params.id);

        const range = parseRange(
            request.headers.range,
            file.fileSize
        );

        reply.header("Accept-Ranges", "bytes");
        reply.header("Content-Type", MIME_TYPES[
            file.fileName.split(".").pop()
        ]);
        reply.header(
            "Content-Disposition",
            `attachment; filename="${file.fileName}"`
        );
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Content-Type-Options", "nosniff");

        if (range?.invalid) {
            file.release();

            return reply
                .code(416)
                .header("Content-Range", `bytes */${file.fileSize}`)
                .send();
        }

        const start = range?.start ?? 0;
        const end = range?.end ?? file.fileSize - 1;
        const contentLength = file.fileSize === 0
            ? 0
            : end - start + 1;

        reply.header("Content-Length", String(contentLength));

        if (range) {
            reply.code(206);
            reply.header(
                "Content-Range",
                `bytes ${start}-${end}/${file.fileSize}`
            );
        }

        const stream = file.fileSize === 0
            ? createReadStream(file.filePath)
            : createReadStream(file.filePath, { start, end });

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            file.release();
        };
        stream.once("end", release);
        stream.once("close", release);
        reply.raw.once("close", release);
        request.raw.once("aborted", release);

        stream.once("error", (error) => {
            release();
            request.log.error(error);
        });

        return reply.send(stream);
    });

    // Cancel download job
    app.delete("/api/v1/downloads/:id", {
        schema: { params: paramsSchema }
    }, async (request) => {
        return {
            success: true,
            message: "Download cancellation requested",
            data: manager.cancelDownload(request.params.id)
        };
    });
}
