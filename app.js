/**
 * Status Prep — WhatsApp Status photo/video preparation
 * Runs entirely in-browser. Photos via Canvas; videos via ffmpeg.wasm
 * (desktop) or Canvas + MediaRecorder (iOS / ffmpeg fallback).
 * Marker: ios-phone-encoder-v1
 */

const RES_MAP = {
  1080: { w: 1080, h: 1920 },
  1440: { w: 1440, h: 2560 },
};

const JPEG_QUALITY = 0.92;
const STATUS_MAX_SECONDS = 30;
const FFMPEG_LOAD_TIMEOUT_MS = 18000;
const FFMPEG_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
const UTIL_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm";

/** @type {object} */
const state = {
  mode: "fit",
  pad: "solid",
  padColor: "#000000",
  res: "1080",
  fmt: "jpeg",
  trim30: true,
  kind: null,
  file: null,
  image: null,
  video: null,
  videoDuration: 0,
  exporting: false,
  ffmpeg: null,
  ffmpegLoaded: false,
  ffmpegLoading: false,
  ffmpegFailed: false,
  lastVideoMime: "video/mp4",
  lastVideoExt: "mp4",
};

const $ = (sel) => document.querySelector(sel);
const uploadSection = $("#upload-section");
const editorSection = $("#editor-section");
const dropzone = $("#dropzone");
const fileInput = $("#file-input");
const browseBtn = $("#browse-btn");
const previewCanvas = $("#preview-canvas");
const previewVideo = $("#preview-video");
const mediaTypeBadge = $("#media-type-badge");
const sourceInfo = $("#source-info");
const photoOptions = $("#photo-options");
const videoOptions = $("#video-options");
const padOptions = $("#pad-options");
const colorPickerWrap = $("#color-picker-wrap");
const modeHint = $("#mode-hint");
const durationHint = $("#duration-hint");
const shareBtn = $("#share-btn");
const exportBtn = $("#export-btn");
const exportBtnLabel = $("#export-btn-label");
const exportStatus = $("#export-status");
const ffmpegStatus = $("#ffmpeg-status");
const ffmpegProgress = $("#ffmpeg-progress");
const ffmpegMsg = $("#ffmpeg-msg");
const playPauseBtn = $("#play-pause-btn");
const changeFileBtn = $("#change-file-btn");
const trim30Check = $("#trim-30");
const padColorInput = $("#pad-color");

function setStatus(msg, type = "") {
  exportStatus.textContent = msg || "";
  exportStatus.className = "export-status" + (type ? ` ${type}` : "");
}

function activateSeg(selector, activeEl) {
  document.querySelectorAll(selector).forEach((b) => b.classList.remove("active"));
  activeEl.classList.add("active");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function isVideoFile(file) {
  if (file.type.startsWith("video/")) return true;
  const n = file.name.toLowerCase();
  return n.endsWith(".mp4") || n.endsWith(".mov") || n.endsWith(".webm") || n.endsWith(".m4v");
}

function isImageFile(file) {
  if (file.type.startsWith("image/")) return true;
  const n = file.name.toLowerCase();
  return /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(n);
}

function isHeic(file) {
  const n = file.name.toLowerCase();
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    n.endsWith(".heic") ||
    n.endsWith(".heif")
  );
}

/** iPhone / iPad / iPod, or iPadOS desktop-UA with touch. */
function isIOSDevice() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ may report as MacIntel with touch
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

/** Safari (including iOS), excluding Chrome/Firefox/Edge/CriOS/FxiOS. */
function isSafariBrowser() {
  const ua = navigator.userAgent || "";
  const isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|FXIOS|Firefox/i.test(ua);
  return isSafari;
}

function prefersPhoneEncoder() {
  return isIOSDevice() || (isSafariBrowser() && /Mobile/i.test(navigator.userAgent || ""));
}

function updateExportLabel() {
  if (state.kind === "video") {
    const ext = state.lastVideoExt === "webm" ? "WebM" : "MP4";
    exportBtnLabel.textContent = `Download ${ext}`;
  } else {
    exportBtnLabel.textContent = state.fmt === "png" ? "Download PNG" : "Download JPEG";
  }
}

function updateModeUI() {
  modeHint.textContent =
    state.mode === "fit"
      ? "Letterbox / pad to 9:16 without cropping"
      : "Center-crop to fill 9:16 (edges may be cut)";

  const showPad = state.mode === "fit";
  padOptions.classList.toggle("hidden", !showPad);
  colorPickerWrap.classList.toggle("hidden", state.pad !== "solid");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function baseName(filename) {
  return filename.replace(/\.[^.]+$/, "") || "status";
}

function layoutContain(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return {
    x: Math.round((dstW - w) / 2),
    y: Math.round((dstH - h) / 2),
    w,
    h,
  };
}

function layoutCover(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return {
    x: Math.round((dstW - w) / 2),
    y: Math.round((dstH - h) / 2),
    w,
    h,
  };
}

function drawImagePreview() {
  if (!state.image) return;
  const frame = previewCanvas.parentElement;
  const cssW = frame.clientWidth;
  const cssH = frame.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(cssW * dpr);
  const H = Math.round(cssH * dpr);
  previewCanvas.width = W;
  previewCanvas.height = H;

  const ctx = previewCanvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const img = state.image;
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  if (state.mode === "fill") {
    const L = layoutCover(srcW, srcH, W, H);
    ctx.drawImage(img, L.x, L.y, L.w, L.h);
  } else {
    if (state.pad === "blur") {
      const cover = layoutCover(srcW, srcH, W, H);
      ctx.save();
      ctx.filter = "blur(28px) brightness(0.55)";
      ctx.drawImage(img, cover.x, cover.y, cover.w, cover.h);
      ctx.restore();
    } else {
      ctx.fillStyle = state.padColor;
      ctx.fillRect(0, 0, W, H);
    }
    const L = layoutContain(srcW, srcH, W, H);
    ctx.drawImage(img, L.x, L.y, L.w, L.h);
  }
}

function syncVideoObjectFit() {
  const frame = previewCanvas.parentElement;
  if (state.mode === "fill") {
    previewVideo.style.objectFit = "cover";
    frame.style.background = "#000";
  } else {
    previewVideo.style.objectFit = "contain";
    frame.style.background = state.pad === "solid" ? state.padColor : "#111";
  }
}

function refreshPreview() {
  if (state.kind === "image") {
    previewCanvas.classList.remove("hidden");
    previewVideo.classList.add("hidden");
    drawImagePreview();
  } else if (state.kind === "video") {
    previewCanvas.classList.add("hidden");
    previewVideo.classList.remove("hidden");
    syncVideoObjectFit();
  }
  updateModeUI();
  updateExportLabel();
}

function exportImageBlob() {
  const { w: W, h: H } = RES_MAP[state.res];
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = state.image;
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (state.mode === "fill") {
    const L = layoutCover(srcW, srcH, W, H);
    ctx.drawImage(img, L.x, L.y, L.w, L.h);
  } else {
    if (state.pad === "blur") {
      const tmp = document.createElement("canvas");
      tmp.width = W;
      tmp.height = H;
      const tctx = tmp.getContext("2d");
      const cover = layoutCover(srcW, srcH, W, H);
      tctx.drawImage(img, cover.x, cover.y, cover.w, cover.h);
      ctx.filter = "blur(48px) brightness(0.55)";
      ctx.drawImage(tmp, 0, 0);
      ctx.filter = "none";
    } else {
      ctx.fillStyle = state.padColor;
      ctx.fillRect(0, 0, W, H);
    }
    const L = layoutContain(srcW, srcH, W, H);
    ctx.drawImage(img, L.x, L.y, L.w, L.h);
  }

  const mime = state.fmt === "png" ? "image/png" : "image/jpeg";
  const quality = state.fmt === "png" ? undefined : JPEG_QUALITY;
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Export failed"))),
      mime,
      quality
    );
  });
}

async function loadImageFromFile(file) {
  if (isHeic(file)) {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new Error(
        "HEIC/HEIF isn’t supported in this browser. Convert to JPEG/PNG first, or try Safari."
      );
    }
  }

  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not decode image"));
        el.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}

async function loadVideoFromFile(file) {
  const url = URL.createObjectURL(file);
  previewVideo.src = url;
  previewVideo.muted = true;
  previewVideo.playsInline = true;
  await new Promise((resolve, reject) => {
    previewVideo.onloadedmetadata = () => resolve();
    previewVideo.onerror = () => reject(new Error("Could not load video"));
  });
  state.videoDuration = previewVideo.duration || 0;
  state.video = url;
  try {
    await previewVideo.play();
  } catch {
    /* autoplay may be blocked */
  }
}

function resetMedia() {
  if (state.video) {
    URL.revokeObjectURL(state.video);
    state.video = null;
  }
  previewVideo.pause();
  previewVideo.removeAttribute("src");
  previewVideo.load();
  if (state.image && typeof state.image.close === "function") {
    try {
      state.image.close();
    } catch {
      /* ImageBitmap close */
    }
  }
  state.image = null;
  state.file = null;
  state.kind = null;
  state.videoDuration = 0;
}

function resolveExportSize() {
  let key = state.res;
  if (prefersPhoneEncoder() && key === "1440") {
    key = "1080";
  }
  return { key, ...RES_MAP[key] };
}

async function handleFile(file) {
  if (!file) return;
  setStatus("");
  resetMedia();

  try {
    if (isVideoFile(file)) {
      state.kind = "video";
      state.file = file;
      await loadVideoFromFile(file);
      mediaTypeBadge.textContent = "Video";
      sourceInfo.textContent = `${previewVideo.videoWidth}×${previewVideo.videoHeight} · ${formatDuration(state.videoDuration)} · ${formatBytes(file.size)}`;
      photoOptions.classList.add("hidden");
      videoOptions.classList.remove("hidden");
      playPauseBtn.classList.remove("hidden");

      // Skip aggressive ffmpeg preload on iOS — it often hangs (no SharedArrayBuffer / memory).
      if (!prefersPhoneEncoder() && !state.ffmpegFailed) {
        void ensureFFmpeg().catch((err) => console.warn("Background encoder preload failed", err));
      }

      if (state.videoDuration > STATUS_MAX_SECONDS) {
        durationHint.textContent = `Source is ${formatDuration(state.videoDuration)} — longer than typical Status (30s). Trim is on by default.`;
        durationHint.classList.add("warn");
        trim30Check.checked = true;
        state.trim30 = true;
      } else if (prefersPhoneEncoder()) {
        durationHint.textContent = `Duration ${formatDuration(state.videoDuration)} · phone encoder (Canvas + MediaRecorder)`;
        durationHint.classList.remove("warn");
      } else {
        durationHint.textContent = `Duration ${formatDuration(state.videoDuration)} · H.264 + AAC MP4 export`;
        durationHint.classList.remove("warn");
      }
    } else if (isImageFile(file)) {
      state.kind = "image";
      state.file = file;
      state.image = await loadImageFromFile(file);
      const w = state.image.naturalWidth || state.image.width;
      const h = state.image.naturalHeight || state.image.height;
      mediaTypeBadge.textContent = "Photo";
      sourceInfo.textContent = `${w}×${h} · ${formatBytes(file.size)}`;
      photoOptions.classList.remove("hidden");
      videoOptions.classList.add("hidden");
      playPauseBtn.classList.add("hidden");
    } else {
      setStatus("Unsupported file type. Use JPG, PNG, WebP, HEIC, MP4, MOV, or WebM.", "error");
      return;
    }

    uploadSection.classList.add("hidden");
    editorSection.classList.remove("hidden");
    refreshPreview();
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Failed to load file", "error");
    uploadSection.classList.remove("hidden");
    editorSection.classList.add("hidden");
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || `Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function ensureFFmpeg() {
  if (state.ffmpegFailed) throw new Error("ffmpeg unavailable");
  if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;
  if (state.ffmpegLoading) {
    while (state.ffmpegLoading) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (state.ffmpegLoaded) return state.ffmpeg;
    if (state.ffmpegFailed) throw new Error("ffmpeg unavailable");
  }

  state.ffmpegLoading = true;
  ffmpegStatus.classList.remove("hidden");
  ffmpegProgress.style.width = "5%";
  ffmpegMsg.textContent = "Downloading encoder (~30MB, once)…";

  try {
    const { FFmpeg } = await import(`${FFMPEG_BASE}/index.js`);
    const { toBlobURL } = await import(`${UTIL_BASE}/index.js`);

    const ffmpeg = new FFmpeg();
    ffmpeg.on("log", ({ message }) => {
      if (message && /error|fail/i.test(message)) console.warn("[ffmpeg]", message);
    });
    ffmpeg.on("progress", ({ progress }) => {
      const pct = Math.min(99, Math.round((progress || 0) * 100));
      ffmpegProgress.style.width = `${Math.max(8, pct)}%`;
      ffmpegMsg.textContent = `Encoding… ${pct}%`;
    });

    const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript");
    const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm");

    ffmpegMsg.textContent = "Initializing ffmpeg core…";
    ffmpegProgress.style.width = "15%";
    await withTimeout(
      ffmpeg.load({ coreURL, wasmURL }),
      FFMPEG_LOAD_TIMEOUT_MS,
      "ffmpeg load timed out"
    );

    state.ffmpeg = ffmpeg;
    state.ffmpegLoaded = true;
    ffmpegProgress.style.width = "100%";
    ffmpegMsg.textContent = "Encoder ready";
    return ffmpeg;
  } catch (err) {
    console.error(err);
    state.ffmpegFailed = true;
    state.ffmpeg = null;
    state.ffmpegLoaded = false;
    ffmpegMsg.textContent = "ffmpeg unavailable — switching to phone encoder…";
    throw err;
  } finally {
    state.ffmpegLoading = false;
  }
}

function extForVideo(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith(".mov")) return ".mov";
  if (n.endsWith(".webm")) return ".webm";
  if (n.endsWith(".m4v")) return ".m4v";
  return ".mp4";
}

function buildSimpleVf(dstW, dstH) {
  if (state.mode === "fill") {
    return `scale=${dstW}:${dstH}:force_original_aspect_ratio=increase,crop=${dstW}:${dstH}`;
  }
  const hex = (state.padColor || "#000000").replace("#", "");
  return `scale=${dstW}:${dstH}:force_original_aspect_ratio=decrease,pad=${dstW}:${dstH}:(ow-iw)/2:(oh-ih)/2:color=0x${hex}`;
}

function pickRecorderMime() {
  const candidates = [
    "video/mp4",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return candidates[0];
  }
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* ignore */
    }
  }
  return "";
}

function drawVideoFrameToCanvas(ctx, video, W, H) {
  const srcW = video.videoWidth || 1;
  const srcH = video.videoHeight || 1;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  if (state.mode === "fill") {
    const L = layoutCover(srcW, srcH, W, H);
    ctx.drawImage(video, L.x, L.y, L.w, L.h);
    return;
  }

  if (state.pad === "blur") {
    const cover = layoutCover(srcW, srcH, W, H);
    ctx.save();
    ctx.filter = "blur(36px) brightness(0.55)";
    ctx.drawImage(video, cover.x, cover.y, cover.w, cover.h);
    ctx.restore();
  } else {
    ctx.fillStyle = state.padColor || "#000000";
    ctx.fillRect(0, 0, W, H);
  }
  const L = layoutContain(srcW, srcH, W, H);
  ctx.drawImage(video, L.x, L.y, L.w, L.h);
}

/**
 * Canvas + MediaRecorder path for iOS / Safari / ffmpeg failure.
 * Draws 9:16 frames, honors trim, prefers mp4 then webm.
 */
async function exportVideoMediaRecorder() {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const { key: resKey, w: dstW, h: dstH } = resolveExportSize();
  if (state.res === "1440" && resKey === "1080") {
    setStatus("Using 1080×1920 on this phone (1440 is too heavy)…");
  }

  ffmpegStatus.classList.remove("hidden");
  ffmpegProgress.style.width = "8%";
  ffmpegMsg.textContent = "Using phone encoder…";
  setStatus("Using phone encoder…");

  const mime = pickRecorderMime();
  const isWebm = mime.includes("webm");
  state.lastVideoMime = isWebm ? "video/webm" : "video/mp4";
  state.lastVideoExt = isWebm ? "webm" : "mp4";
  updateExportLabel();

  const canvas = document.createElement("canvas");
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext("2d", { alpha: false });

  // Dedicated video element so we can seek / unmute without fighting the preview.
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = false;
  video.preload = "auto";
  video.src = state.video;
  video.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Could not load video for encoding"));
  });

  const duration = Number.isFinite(video.duration) ? video.duration : state.videoDuration;
  const endTime = state.trim30
    ? Math.min(STATUS_MAX_SECONDS, duration || STATUS_MAX_SECONDS)
    : duration || STATUS_MAX_SECONDS;

  if (!Number.isFinite(endTime) || endTime <= 0) {
    throw new Error("Could not determine video duration.");
  }

  video.currentTime = 0;
  await new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    // Some browsers fire seeked immediately at 0
    setTimeout(done, 250);
  });

  const fps = 30;
  let stream;
  try {
    stream = canvas.captureStream(fps);
  } catch (err) {
    throw new Error("Canvas captureStream is not supported on this browser.");
  }

  // Best-effort audio from the source video.
  try {
    if (typeof video.captureStream === "function") {
      const vStream = video.captureStream();
      const audioTracks = vStream.getAudioTracks();
      if (audioTracks.length) {
        stream.addTrack(audioTracks[0]);
      }
    }
  } catch (err) {
    console.warn("Audio capture unavailable", err);
  }

  const chunks = [];
  const recorderOpts = mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : { videoBitsPerSecond: 8_000_000 };
  let recorder;
  try {
    recorder = new MediaRecorder(stream, recorderOpts);
  } catch {
    recorder = new MediaRecorder(stream);
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject(e.error || new Error("MediaRecorder failed"));
  });

  let rafId = 0;
  let drawing = true;
  const drawLoop = () => {
    if (!drawing) return;
    try {
      drawVideoFrameToCanvas(ctx, video, dstW, dstH);
    } catch (err) {
      console.warn("Frame draw error", err);
    }
    const t = video.currentTime || 0;
    const pct = Math.min(95, Math.round((t / endTime) * 100));
    ffmpegProgress.style.width = `${Math.max(10, pct)}%`;
    ffmpegMsg.textContent = `Using phone encoder… ${pct}%`;
    rafId = requestAnimationFrame(drawLoop);
  };

  // Draw first frame before starting so the recorder has content.
  drawVideoFrameToCanvas(ctx, video, dstW, dstH);
  recorder.start(200);
  rafId = requestAnimationFrame(drawLoop);

  try {
    await video.play();
  } catch (err) {
    // If unmuted play fails, retry muted (no audio track then).
    video.muted = true;
    await video.play();
  }

  await new Promise((resolve, reject) => {
    const onTime = () => {
      if (video.currentTime >= endTime - 0.05) {
        video.pause();
        cleanup();
        resolve();
      }
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("ended", onEnded);
      clearTimeout(safety);
    };
    const safety = setTimeout(() => {
      video.pause();
      cleanup();
      resolve();
    }, (endTime + 3) * 1000);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("ended", onEnded);
  });

  drawing = false;
  cancelAnimationFrame(rafId);
  // Final frame
  drawVideoFrameToCanvas(ctx, video, dstW, dstH);

  if (recorder.state !== "inactive") {
    recorder.stop();
  }
  await stopped;

  // Stop tracks
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (!chunks.length) {
    throw new Error("Phone encoder produced an empty file. Try a shorter clip or Download on desktop.");
  }

  const blob = new Blob(chunks, { type: state.lastVideoMime });
  ffmpegProgress.style.width = "100%";
  ffmpegMsg.textContent = "Done (phone encoder)";
  setStatus("");
  return blob;
}

async function exportVideoFFmpeg() {
  const { fetchFile } = await import(`${UTIL_BASE}/index.js`);
  const ffmpeg = await ensureFFmpeg();
  const { w: dstW, h: dstH } = resolveExportSize();

  const inName = "input" + extForVideo(state.file);
  const outName = "output.mp4";

  ffmpegMsg.textContent = "Writing input…";
  ffmpegProgress.style.width = "20%";
  await ffmpeg.writeFile(inName, await fetchFile(state.file));

  const is1440 = state.res === "1440" && dstW === 1440;
  const crf = is1440 ? "22" : "23";
  const maxrate = is1440 ? "14M" : "10M";
  const bufsize = is1440 ? "28M" : "20M";

  const useBlurPad = state.mode === "fit" && state.pad === "blur";

  const runEncode = async (withAudio) => {
    const args = ["-i", inName];
    if (state.trim30) {
      args.push("-t", String(STATUS_MAX_SECONDS));
    }

    if (useBlurPad) {
      const fc = [
        `[0:v]split=2[bg][fg]`,
        `[bg]scale=${dstW}:${dstH}:force_original_aspect_ratio=increase,crop=${dstW}:${dstH},gblur=sigma=20,eq=brightness=-0.06[bg2]`,
        `[fg]scale=${dstW}:${dstH}:force_original_aspect_ratio=decrease[fg2]`,
        `[bg2][fg2]overlay=(W-w)/2:(H-h)/2[vout]`,
      ].join(";");
      args.push("-filter_complex", fc, "-map", "[vout]");
      if (withAudio) args.push("-map", "0:a?");
    } else {
      args.push("-vf", buildSimpleVf(dstW, dstH));
      if (withAudio) {
        args.push("-map", "0:v:0", "-map", "0:a?");
      }
    }

    args.push(
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", crf,
      "-maxrate", maxrate,
      "-bufsize", bufsize,
      "-pix_fmt", "yuv420p"
    );

    if (withAudio) {
      args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "44100");
    } else {
      args.push("-an");
    }

    args.push("-movflags", "+faststart", "-shortest", outName);
    await ffmpeg.exec(args);
  };

  ffmpegMsg.textContent = "Encoding H.264…";
  ffmpegProgress.style.width = "30%";

  try {
    await runEncode(true);
  } catch (e) {
    console.warn("Encode with audio failed, retrying without audio", e);
    try {
      await ffmpeg.deleteFile(outName);
    } catch {
      /* may not exist */
    }
    if (useBlurPad) {
      const savedPad = state.pad;
      state.pad = "solid";
      state.padColor = "#000000";
      try {
        await runEncode(false);
      } finally {
        state.pad = savedPad;
      }
    } else {
      await runEncode(false);
    }
  }

  const data = await ffmpeg.readFile(outName);
  const blob = new Blob([data.buffer], { type: "video/mp4" });

  try {
    await ffmpeg.deleteFile(inName);
    await ffmpeg.deleteFile(outName);
  } catch {
    /* ignore */
  }

  state.lastVideoMime = "video/mp4";
  state.lastVideoExt = "mp4";
  ffmpegProgress.style.width = "100%";
  ffmpegMsg.textContent = "Done";
  return blob;
}

async function exportVideo() {
  // Prefer phone encoder on iOS / mobile Safari; otherwise try ffmpeg with timeout fallback.
  if (prefersPhoneEncoder() || state.ffmpegFailed) {
    return exportVideoMediaRecorder();
  }

  try {
    return await exportVideoFFmpeg();
  } catch (err) {
    console.warn("ffmpeg path failed, falling back to MediaRecorder", err);
    state.ffmpegFailed = true;
    ffmpegMsg.textContent = "Switching to phone encoder…";
    setStatus("ffmpeg stalled — using phone encoder…");
    return exportVideoMediaRecorder();
  }
}

function getExportName() {
  if (state.kind === "image") {
    const ext = state.fmt === "png" ? "png" : "jpg";
    return `${baseName(state.file.name)}_status_${state.res}.${ext}`;
  }
  const { key } = resolveExportSize();
  return `${baseName(state.file.name)}_status_${key}.${state.lastVideoExt || "mp4"}`;
}

async function createExport() {
  if (state.kind === "image") return exportImageBlob();
  ffmpegStatus.classList.remove("hidden");
  return exportVideo();
}

function setExporting(exporting) {
  state.exporting = exporting;
  shareBtn.disabled = exporting;
  exportBtn.disabled = exporting;
}

async function onExport() {
  if (!state.file || state.exporting) return;
  setExporting(true);
  setStatus(prefersPhoneEncoder() && state.kind === "video" ? "Using phone encoder…" : "Working…");

  try {
    const blob = await createExport();
    const name = getExportName();
    downloadBlob(blob, name);
    setStatus(`Saved ${name} (${formatBytes(blob.size)})`, "success");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Export failed", "error");
  } finally {
    setExporting(false);
  }
}

async function onShare() {
  if (!state.file || state.exporting) return;
  setExporting(true);
  setStatus(
    prefersPhoneEncoder() && state.kind === "video"
      ? "Preparing share with phone encoder…"
      : "Preparing share…"
  );

  let blob;
  let name;
  try {
    blob = await createExport();
    name = getExportName();
    let file = null;
    try {
      if (typeof File !== "undefined") file = new File([blob], name, { type: blob.type || state.lastVideoMime });
    } catch {
      /* Fall back to download when File sharing is unavailable. */
    }

    let supportsFileShare = false;
    if (file && typeof navigator.share === "function") {
      try {
        supportsFileShare = !navigator.canShare || navigator.canShare({ files: [file] });
      } catch {
        supportsFileShare = false;
      }
    }

    if (!supportsFileShare) {
      downloadBlob(blob, name);
      setStatus("Sharing isn’t supported here — downloaded the file. Use your browser’s share menu to send it to WhatsApp.", "success");
      return;
    }

    await navigator.share({
      title: "WhatsApp Status",
      files: [file],
    });
    setStatus("Shared successfully.", "success");
  } catch (err) {
    if (err && err.name === "AbortError") {
      setStatus("Share canceled.");
    } else if (err && err.name === "NotAllowedError" && blob && name) {
      downloadBlob(blob, name);
      setStatus("Share was unavailable — downloaded the file. Use your browser’s share menu to send it to WhatsApp.", "success");
    } else {
      console.error(err);
      setStatus(err.message || "Share failed", "error");
    }
  } finally {
    setExporting(false);
  }
}
function openPicker() {
  fileInput.click();
}

browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openPicker();
});

dropzone.addEventListener("click", (e) => {
  if (e.target === browseBtn || browseBtn.contains(e.target)) return;
  openPicker();
});

dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    openPicker();
  }
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) handleFile(f);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

changeFileBtn.addEventListener("click", () => {
  resetMedia();
  editorSection.classList.add("hidden");
  uploadSection.classList.remove("hidden");
  setStatus("");
  ffmpegStatus.classList.add("hidden");
});

playPauseBtn.addEventListener("click", () => {
  if (previewVideo.paused) previewVideo.play();
  else previewVideo.pause();
});

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    activateSeg("[data-mode]", btn);
    refreshPreview();
  });
});

document.querySelectorAll("[data-pad]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.pad = btn.dataset.pad;
    activateSeg("[data-pad]", btn);
    refreshPreview();
  });
});

document.querySelectorAll("[data-res]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.res = btn.dataset.res;
    activateSeg("[data-res]", btn);
  });
});

document.querySelectorAll("[data-fmt]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.fmt = btn.dataset.fmt;
    activateSeg("[data-fmt]", btn);
    updateExportLabel();
  });
});

padColorInput.addEventListener("input", () => {
  state.padColor = padColorInput.value;
  refreshPreview();
});

trim30Check.addEventListener("change", () => {
  state.trim30 = trim30Check.checked;
});

shareBtn.addEventListener("click", onShare);
exportBtn.addEventListener("click", onExport);

window.addEventListener("resize", () => {
  if (state.kind === "image") drawImagePreview();
});

updateModeUI();
updateExportLabel();
