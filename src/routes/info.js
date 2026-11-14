export default async function infoRoutes(app, { getVideoInfo }) {
    app.get("/api/v1/info", {
        config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
        schema: {
            querystring: {
                type: "object",
                required: ["url"],
                additionalProperties: false,
                properties: {
                    url: {
                        type: "string",
                        minLength: 1,
                        maxLength: 2048
                    }
                }
            }
        }
    }, async (request) => {
        const video = await getVideoInfo(request.query.url);

        return {
            success: true,
            data: video
        };
    });
}
