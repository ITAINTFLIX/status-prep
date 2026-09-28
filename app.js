/**
 * Status Prep — WhatsApp Status photo/video preparation
 * Runs entirely in-browser. Photos via Canvas; videos via ffmpeg.wasm.
 */

const RES_MAP = {
  1080: { w: 1080, h: 1920 },
  1440: { w: 1440, h: 2560 },
};

const JPEG_QUALITY = 0.92;
const STATUS_MAX_SECONDS = 30;
const FFMPEG_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
const UTIL_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm";

/** @type {object} */
const state = {
  mode: "fit",
  pad: "blur",
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

function updateExportLabel() {
  if (state.kind === "video") {
    exportBtnLabel.textContent = "Download MP4";
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

      if (state.videoDuration > STATUS_MAX_SECONDS) {
        durationHint.textContent = `Source is ${formatDuration(state.videoDuration)} — longer than typical Status (30s). Trim is on by default.`;
        durationHint.classList.add("warn");
        trim30Check.checked = true;
        state.trim30 = true;
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

async function ensureFFmpeg() {
  if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;
  if (state.ffmpegLoading) {
    while (state.ffmpegLoading) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (state.ffmpegLoaded) return state.ffmpeg;
  }

  state.ffmpegLoading = true;
  ffmpegStatus.classList.remove("hidden");
  ffmpegProgress.style.width = "5%";
  ffmpegMsg.textContent = "Loading ffmpeg.wasm (first time may take a moment)…";

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
    await ffmpeg.load({ coreURL, wasmURL });

    state.ffmpeg = ffmpeg;
    state.ffmpegLoaded = true;
    ffmpegProgress.style.width = "100%";
    ffmpegMsg.textContent = "ffmpeg ready";
    return ffmpeg;
  } catch (err) {
    console.error(err);
    ffmpegMsg.textContent = "Failed to load ffmpeg.wasm — check network / CDN";
    throw new Error("Could not load ffmpeg.wasm. Stay online for the first video export.");
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

async function exportVideo() {
  const { fetchFile } = await import(`${UTIL_BASE}/index.js`);
  const ffmpeg = await ensureFFmpeg();
  const { w: dstW, h: dstH } = RES_MAP[state.res];

  const inName = "input" + extForVideo(state.file);
  const outName = "output.mp4";

  ffmpegMsg.textContent = "Writing input…";
  ffmpegProgress.style.width = "20%";
  await ffmpeg.writeFile(inName, await fetchFile(state.file));

  const is1440 = state.res === "1440";
  const crf = is1440 ? "20" : "21";
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
      "-preset", "medium",
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
    // Fallback: solid pad if blur graph failed, no audio
    if (useBlurPad) {
      // Force simple pad path on retry
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

  ffmpegProgress.style.width = "100%";
  ffmpegMsg.textContent = "Done";
  return blob;
}

async function onExport() {
  if (!state.file || state.exporting) return;
  state.exporting = true;
  exportBtn.disabled = true;
  setStatus("Working…");

  try {
    if (state.kind === "image") {
      const blob = await exportImageBlob();
      const ext = state.fmt === "png" ? "png" : "jpg";
      const name = `${baseName(state.file.name)}_status_${state.res}.${ext}`;
      downloadBlob(blob, name);
      setStatus(`Saved ${name} (${formatBytes(blob.size)})`, "success");
    } else {
      ffmpegStatus.classList.remove("hidden");
      const blob = await exportVideo();
      const name = `${baseName(state.file.name)}_status_${state.res}.mp4`;
      downloadBlob(blob, name);
      setStatus(`Saved ${name} (${formatBytes(blob.size)})`, "success");
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Export failed", "error");
  } finally {
    state.exporting = false;
    exportBtn.disabled = false;
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

exportBtn.addEventListener("click", onExport);

window.addEventListener("resize", () => {
  if (state.kind === "image") drawImagePreview();
});

updateModeUI();
updateExportLabel();
