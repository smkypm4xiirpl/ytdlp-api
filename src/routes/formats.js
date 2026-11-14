export default async function formatsRoutes(app, { getVideoFormats }) {
    app.get("/api/v1/formats", {
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
        const formats = await getVideoFormats(request.query.url);

        return {
            success: true,
            data: formats
        };
    });
}
