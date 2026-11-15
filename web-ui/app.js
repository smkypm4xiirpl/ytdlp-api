const $ = (id) => document.getElementById(id);
const DEFAULT_API = "http://sekai.hopto.org:3100";
const LARGE_FILE_FALLBACK_LIMIT = 512 * 1024 * 1024;

let apiKey = "";
let apiBase = DEFAULT_API;
let videoInfo = null;
let videoFormats = null;
let activeJobId = "";
let pollTimer = null;
let healthTimer = null;
let refreshingJob = false;

function setMessage(message, kind = "") {
  const node = $("request-message");
  node.textContent = message;
  node.className = `inline-message ${kind}`.trim();
  node.hidden = !message;
}

function showCorsHint() {
  $("cors-note").hidden = false;
}

function normalizeBase(value) {
  const parsed = new URL(value.trim());
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API URL must start with http:// or https://");
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function urlFor(path) {
  return `${apiBase}${path}`;
}

async function apiJson(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (apiKey) headers.set("x-api-key", apiKey);
  const response = await fetch(urlFor(path), { ...options, headers, cache: "no-store" });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || body?.success === false) {
    const error = new Error(body?.error?.message || `API request failed (${response.status})`);
    error.status = response.status;
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

function explainError(error) {
  if (error instanceof TypeError) {
    showCorsHint();
    return "Browser could not read the API response. Check the exact CORS origin and that the API is reachable.";
  }
  if (error.name === "AbortError") return "Request cancelled.";
  return error.message || "Unexpected error.";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${rest}s`;
}

function setApiStatus(state, label, latency = "—") {
  const pill = $("api-status");
  pill.className = `status-pill status-${state}`;
  pill.querySelector("span").textContent = label;
  $("api-latency").textContent = latency;
}

async function checkHealth() {
  const start = performance.now();
  try {
    const response = await fetch(urlFor("/api/v1/health"), { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    if (!response.ok || body?.data?.status !== "online") throw new Error(`Health returned ${response.status}`);
    setApiStatus("online", "API online", `${Math.round(performance.now() - start)} ms`);
    $("cors-note").hidden = true;
  } catch (error) {
    setApiStatus("offline", "API unreachable");
    if (error instanceof TypeError) showCorsHint();
  }
}

function currentFormats() {
  if (!videoFormats) return [];
  const output = $("output-format").value;
  if (output === "mp3") return videoFormats.formats.audio || [];
  const videos = videoFormats.formats.video || [];
  return output === "mp4" ? videos.filter((item) => /^avc1(?:\.|$)/i.test(item.videoCodec || "")) : videos;
}

function populateFormatOptions() {
  const select = $("source-format");
  select.replaceChildren();
  const options = currentFormats();
  for (const format of options) {
    const option = document.createElement("option");
    option.value = format.formatId;
    if ($("output-format").value === "mp3") {
      option.textContent = `${format.formatId} · ${format.audioCodec || "audio"} · ${format.audioBitrateKbps ?? "?"} kbps`;
    } else {
      option.textContent = `${format.formatId} · ${format.height ? `${format.height}p` : format.resolution || "video"} · ${format.videoCodec || "codec unknown"}`;
    }
    select.append(option);
  }
  const output = $("output-format").value;
  const noFormats = options.length === 0;
  select.disabled = noFormats;
  $("create-button").disabled = noFormats;
  $("format-hint").hidden = !noFormats;
  $("format-hint").textContent = noFormats
    ? output === "mp4" ? "No H.264 video format was returned. Try MKV or MP3." : "The API did not return a compatible source format."
    : output === "mp4" ? "MP4 choices are filtered to H.264 video. The API validates the final file before marking it complete."
      : output === "mkv" ? "MKV keeps the selected source video stream and pairs it with the best available audio."
        : "MP3 extracts audio only; the output is validated by the API.";
}

async function inspectVideo(event) {
  event.preventDefault();
  const videoUrl = $("video-url").value.trim();
  if (!videoUrl) return;
  const button = $("inspect-button");
  button.disabled = true;
  button.textContent = "Inspecting…";
  setMessage("");
  try {
    const query = `?url=${encodeURIComponent(videoUrl)}`;
    const [info, formats] = await Promise.all([
      apiJson(`/api/v1/info${query}`, { signal: AbortSignal.timeout(90000) }),
      apiJson(`/api/v1/formats${query}`, { signal: AbortSignal.timeout(90000) })
    ]);
    videoInfo = info.data;
    videoFormats = formats.data;
    $("video-title").textContent = videoInfo.title || videoInfo.id || "YouTube video";
    const duration = videoInfo.duration ? formatDuration(videoInfo.duration) : "duration unavailable";
    const channel = videoInfo.channel || videoInfo.uploader || "Unknown channel";
    $("video-details").textContent = `${channel}  ·  ${duration}  ·  ${formats.data.formatCount.video} video / ${formats.data.formatCount.audio} audio formats`;
    $("video-summary").hidden = false;
    $("format-controls").hidden = false;
    $("output-format").value = "mp4";
    populateFormatOptions();
    setMessage("Video details and formats loaded.");
  } catch (error) {
    setMessage(explainError(error), "error");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Inspect <span aria-hidden="true">→</span>';
  }
}

function renderJob(job) {
  $("empty-monitor").hidden = true;
  $("job-card").hidden = false;
  const status = String(job.status || "unknown").toLowerCase();
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const state = $("job-state");
  state.textContent = status.toUpperCase();
  state.dataset.state = status;
  $("job-name").textContent = `${job.output?.toUpperCase() || "MEDIA"} · ${job.videoId || job.id}`;
  $("job-percent").textContent = `${Math.round(progress)}%`;
  $("progress-bar").style.width = `${progress}%`;
  const transferred = job.downloadedBytes == null ? "—" : formatBytes(job.downloadedBytes);
  const total = job.totalBytes == null ? "" : ` / ${formatBytes(job.totalBytes)}`;
  $("job-bytes").textContent = `${transferred}${total}`;
  $("job-speed").textContent = job.speed || "—";
  $("job-eta").textContent = job.eta == null ? "—" : typeof job.eta === "number" ? formatDuration(job.eta) : String(job.eta);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(status);
  $("cancel-button").hidden = terminal;
  $("download-button").hidden = status !== "completed";
  $("job-error").hidden = !job.error;
  $("job-error").textContent = job.error ? `${job.error.code || "DOWNLOAD_FAILED"}: ${job.error.message || "Download failed"}` : "";
  if (terminal && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function refreshActiveJob() {
  if (!apiKey || !activeJobId || refreshingJob) return;
  refreshingJob = true;
  try {
    const result = await apiJson(`/api/v1/downloads/${encodeURIComponent(activeJobId)}`, { signal: AbortSignal.timeout(12000) });
    renderJob(result.data);
    if (["completed", "failed", "cancelled", "interrupted"].includes(result.data.status)) await loadRecentJobs();
  } catch (error) {
    setMessage(explainError(error), "error");
  } finally {
    refreshingJob = false;
  }
}

async function createJob() {
  const formatId = $("source-format").value;
  if (!formatId || !videoInfo) return;
  const button = $("create-button");
  button.disabled = true;
  setMessage("Submitting job…");
  try {
    const result = await apiJson("/api/v1/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: $("video-url").value.trim(), formatId, output: $("output-format").value }),
      signal: AbortSignal.timeout(20000)
    });
    activeJobId = result.data.id;
    renderJob(result.data);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshActiveJob, 3000);
    await refreshActiveJob();
    setMessage(`Job ${activeJobId} was accepted by the API.`);
    await loadRecentJobs();
  } catch (error) {
    setMessage(explainError(error), "error");
  } finally {
    button.disabled = false;
    populateFormatOptions();
  }
}

async function cancelJob() {
  if (!activeJobId) return;
  $("cancel-button").disabled = true;
  try {
    await apiJson(`/api/v1/downloads/${encodeURIComponent(activeJobId)}`, { method: "DELETE", signal: AbortSignal.timeout(15000) });
    setMessage("Cancellation requested.");
    await refreshActiveJob();
  } catch (error) {
    setMessage(explainError(error), "error");
  } finally {
    $("cancel-button").disabled = false;
  }
}

async function saveFile() {
  if (!activeJobId || !apiKey) return;
  const extension = $("output-format").value;
  const suggestedName = `${activeJobId}.${extension}`;
  let handlePromise = null;
  if (typeof window.showSaveFilePicker === "function") {
    try { handlePromise = window.showSaveFilePicker({ suggestedName }); }
    catch (error) { if (error.name === "AbortError") return; }
  }
  const button = $("download-button");
  button.disabled = true;
  $("file-progress").hidden = false;
  $("file-progress").textContent = "Connecting to file stream…";
  try {
    const response = await fetch(urlFor(`/api/v1/downloads/${encodeURIComponent(activeJobId)}/file`), {
      headers: { "x-api-key": apiKey }, cache: "no-store"
    });
    if (!response.ok || !response.body) {
      let detail = "File request failed.";
      try { detail = (await response.json()).error?.message || detail; } catch {}
      throw new Error(detail);
    }
    const expected = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    let lastAt = performance.now();
    let lastBytes = 0;
    const reader = response.body.getReader();
    if (handlePromise) {
      const handle = await handlePromise;
      const writable = await handle.createWritable();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.byteLength;
          const now = performance.now();
          if (now - lastAt >= 500) {
            const speed = (received - lastBytes) * 1000 / (now - lastAt);
            $("file-progress").textContent = `Saving ${formatBytes(received)}${expected ? ` / ${formatBytes(expected)}` : ""} · ${formatBytes(speed)}/s`;
            lastAt = now; lastBytes = received;
          }
        }
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => {});
        throw error;
      }
      $("file-progress").textContent = `Saved ${formatBytes(received)} to disk.`;
    } else {
      if (expected > LARGE_FILE_FALLBACK_LIMIT) {
        await reader.cancel();
        throw new Error("This browser cannot stream directly to disk here, and the file is too large for the memory-based fallback. Use a secure browser context or an API client.");
      }
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > LARGE_FILE_FALLBACK_LIMIT) {
          await reader.cancel();
          throw new Error("Download exceeded the 512 MB browser memory safety limit.");
        }
        chunks.push(value);
        const now = performance.now();
        if (now - lastAt >= 500) {
          const speed = (received - lastBytes) * 1000 / (now - lastAt);
          $("file-progress").textContent = `Receiving ${formatBytes(received)}${expected ? ` / ${formatBytes(expected)}` : ""} · ${formatBytes(speed)}/s`;
          lastAt = now; lastBytes = received;
        }
      }
      const blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = suggestedName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      $("file-progress").textContent = `Received ${formatBytes(received)}. Browser download started.`;
    }
  } catch (error) {
    if (error instanceof TypeError) showCorsHint();
    $("file-progress").textContent = error.name === "AbortError" ? "Save cancelled." : explainError(error);
  } finally {
    button.disabled = false;
  }
}

async function loadRecentJobs() {
  if (!apiKey) return;
  const container = $("recent-jobs");
  try {
    const result = await apiJson("/api/v1/downloads", { signal: AbortSignal.timeout(15000) });
    const jobs = [...result.data].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 8);
    container.replaceChildren();
    $("recent-count").textContent = String(jobs.length);
    if (!jobs.length) {
      const empty = document.createElement("div"); empty.className = "recent-empty"; empty.textContent = "No jobs yet."; container.append(empty); return;
    }
    for (const job of jobs) {
      const row = document.createElement("button");
      row.type = "button"; row.className = "recent-row"; row.dataset.jobId = job.id;
      const main = document.createElement("span"); main.className = "recent-row-main";
      const title = document.createElement("span"); title.className = "recent-row-title"; title.textContent = `${job.output?.toUpperCase() || "MEDIA"} · ${job.videoId || job.id}`;
      const meta = document.createElement("span"); meta.className = "recent-row-meta"; meta.textContent = `${job.status} · ${job.fileSize ? formatBytes(job.fileSize) : job.progress + "%"}`;
      const state = document.createElement("span"); state.className = "recent-row-state"; state.textContent = job.status;
      main.append(title, meta); row.append(main, state); container.append(row);
    }
  } catch (error) {
    container.replaceChildren();
    const empty = document.createElement("div"); empty.className = "recent-empty"; empty.textContent = explainError(error); container.append(empty);
  }
}

async function connect() {
  const button = $("connect-button");
  const entered = $("api-key").value.trim();
  try {
    apiBase = normalizeBase($("api-base").value);
    if (!entered) throw new Error("Enter the API key to connect.");
    apiKey = entered;
    button.disabled = true;
    await apiJson("/api/v1/downloads", { signal: AbortSignal.timeout(12000) });
    $("api-key").value = "";
    $("workspace").hidden = false;
    button.textContent = "Disconnect";
    button.classList.remove("button-secondary"); button.classList.add("button-quiet");
    button.disabled = false;
    $("http-warning").hidden = location.protocol === "https:" && new URL(apiBase).protocol === "https:";
    $("recent-jobs").querySelector(".recent-empty")?.remove();
    await Promise.all([checkHealth(), loadRecentJobs()]);
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(checkHealth, 15000);
  } catch (error) {
    apiKey = "";
    button.disabled = false;
    setMessage(explainError(error), "error");
  }
}

function disconnect() {
  apiKey = "";
  videoInfo = null;
  videoFormats = null;
  activeJobId = "";
  if (pollTimer) clearInterval(pollTimer);
  if (healthTimer) clearInterval(healthTimer);
  pollTimer = null; healthTimer = null;
  $("api-key").value = "";
  $("workspace").hidden = true;
  $("format-controls").hidden = true;
  $("video-summary").hidden = true;
  $("empty-monitor").hidden = false;
  $("job-card").hidden = true;
  $("recent-jobs").replaceChildren();
  $("recent-count").textContent = "0";
  $("connect-button").textContent = "Connect";
  $("connect-button").classList.add("button-secondary");
  $("connect-button").classList.remove("button-quiet");
  setMessage("Disconnected. The API key was cleared from this page.");
}

$("api-base").value = DEFAULT_API;
if (location.protocol === "http:" || location.protocol === "file:") $("http-warning").hidden = false;
$("inspect-form").addEventListener("submit", inspectVideo);
$("output-format").addEventListener("change", populateFormatOptions);
$("create-button").addEventListener("click", createJob);
$("cancel-button").addEventListener("click", cancelJob);
$("download-button").addEventListener("click", saveFile);
$("refresh-jobs").addEventListener("click", loadRecentJobs);
$("connect-button").addEventListener("click", () => apiKey ? disconnect() : connect());
$("recent-jobs").addEventListener("click", (event) => {
  const row = event.target.closest("[data-job-id]");
  if (!row) return;
  activeJobId = row.dataset.jobId;
  $("job-card").hidden = false;
  $("empty-monitor").hidden = true;
  refreshActiveJob();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshActiveJob, 3000);
});
checkHealth();
