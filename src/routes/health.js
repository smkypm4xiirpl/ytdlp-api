export default async function healthRoutes(app) {
    app.get("/api/v1/health", async () => {
        return {
            success: true,
            data: {
                status: "online",
                service: "YTDLP API",
                version: "1.0.0",
                timestamp: new Date().toISOString()
            }
        };
    });
}
