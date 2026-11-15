# YT-DLP API

Self-hosted YouTube metadata and media download API built with Fastify, yt-dlp, FFmpeg, and SQLite.

## Requirements

- Node.js **22.15.0 or newer**.
- yt-dlp executable.
- FFmpeg and FFprobe executables.
- A readable cookies file path. The API passes this path to yt-dlp; keep the file private and never commit it.

## Install and run

From the project directory:

```bash
npm ci
npm start
```

The API defaults to `127.0.0.1:3100`. Set `HOST` and `PORT` only when the deployment requires different values. The application validates required configuration at startup and exits with an error if it is missing or invalid.

## Configuration

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `API_KEY` | API key, at least 32 UTF-8 bytes. Keep it private. |
| `YTDLP_PATH` | yt-dlp executable path. |
| `YTDLP_COOKIES_PATH` | Readable cookies-file path used by yt-dlp. |
| `FFMPEG_PATH` | Directory containing the FFmpeg executable. |
| `FFPROBE_PATH` | FFprobe executable path. |
| `STORAGE_PATH` | Directory for downloaded media and temporary processing output. |
| `LOG_PATH` | Directory created during startup for deployment/log housekeeping. Fastify logging currently writes to stdout. |

Optional settings and defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime environment label. |
| `HOST` | `127.0.0.1` | Listener address. |
| `PORT` | `3100` | Listener port. |
| `DOWNLOAD_CONCURRENCY` | `2` | Number of active download jobs. |
| `MAX_QUEUE_SIZE` | `30` | Maximum running plus waiting jobs. |
| `MAX_FILE_SIZE` | `8589934592` | Maximum output size in bytes. |
| `MAX_VIDEO_DURATION` | `14400` | Maximum video duration in seconds. |
| `FILE_TTL_MINUTES` | `60` | Retention period for completed files. |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown deadline. |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated exact browser origins allowed to call the API. Do not use `*`. |

The SQLite database is stored as `jobs.sqlite` beside `STORAGE_PATH`. SQLite uses WAL mode and an exclusive instance lock in that directory. Protect the database, its WAL/SHM files, the cookies file, and download storage.

## Authentication and transport

`GET /api/v1/health` is public. Other API routes require either:

```http
x-api-key: YOUR_API_KEY
```

or:

```http
Authorization: Bearer YOUR_API_KEY
```

Do not put the API key in a URL or commit it to source control. **HTTP does not encrypt the API key or response data**; use only on a trusted network until HTTPS is available.

## API endpoints

All responses use JSON except the media file endpoint. Errors follow this shape:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe error message"
  }
}
```

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | No | Public liveness check. |
| `GET /api/v1/info?url=...` | Yes | Video metadata. |
| `GET /api/v1/formats?url=...` | Yes | Available video and audio formats. |
| `POST /api/v1/downloads` | Yes | Create an asynchronous download job; returns `202`. |
| `GET /api/v1/downloads` | Yes | List jobs. |
| `GET /api/v1/downloads/:id` | Yes | Read job status and progress. |
| `GET /api/v1/downloads/:id/file` | Yes | Stream a completed file; supports HTTP Range. |
| `DELETE /api/v1/downloads/:id` | Yes | Request job cancellation. |

Create a job with JSON:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "formatId": "FORMAT_ID_FROM_FORMATS_RESPONSE",
  "output": "mp4"
}
```

`output` must be `mp4`, `mkv`, or `mp3`. Jobs move through `queued`, `downloading`, `processing`, and a terminal state such as `completed`, `failed`, `cancelled`, or `interrupted`. Poll the job endpoint to monitor progress; download the file only after `completed`.

MP4 output is validated for H.264 video and AAC-LC audio, MKV retains source streams according to the selected format, and MP3 output is validated as audio-only MP3. The API validates the actual file with FFprobe before publishing a job as completed.

## Local browser UI

A static HTML/CSS/JavaScript client is in [`web-ui/`](web-ui/). It asks for the API key at runtime and keeps it only in the page's memory; it does not save the key to browser storage.

To serve the UI locally on the laptop with Python:

```bash
python -m http.server 5500 --bind 127.0.0.1 --directory web-ui
```

Open `http://127.0.0.1:5500`. The API must allow that exact origin for browser requests. Configure this on the API runtime:

```text
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5500
```

If the page is opened at a different host, scheme, or port, allow that exact origin instead. CORS handles browser access only; it is not authentication or encryption. A browser page calling the public HTTP API still sends the API key over unencrypted HTTP.

The UI streams to disk using the browser File System Access API when available. Its fallback buffers files in browser memory and refuses files larger than 512 MiB.

## Tests

```bash
npm test
```

The test suite uses local fixtures and fake executables; it does not download YouTube videos.

## GitHub Actions

The Linux workflow runs on Ubuntu 24.04 with Node.js 22, installs locked dependencies, checks JavaScript syntax, and runs the test suite.
