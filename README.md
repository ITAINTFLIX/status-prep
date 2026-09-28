# Status Prep

Prepare photos and short videos for **WhatsApp Status** at high quality (up to 1440×2560). Runs entirely in your browser — no backend, no uploads to a server.

## Features

- Drag-and-drop or file picker for images (JPG, PNG, WebP, HEIC best-effort) and videos (MP4, MOV, WebM)
- Live 9:16 preview
- **Fit** (letterbox with blur or solid pad) and **Fill** (center crop)
- Export at **1080×1920** (recommended) or **1440×2560** (max prep)
- Photos: high-quality JPEG (~0.92) or PNG via Canvas
- Videos: ffmpeg.wasm → H.264 + AAC MP4, optional trim to first 30s
- Dark, mobile-friendly UI

## Disclaimer

WhatsApp **re-encodes** Status media on upload. This tool maximizes quality *before* you share; it cannot force the final bitrate or resolution viewers receive.

## Local use

No build step. From this folder:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in a modern browser.

> **Note:** `file://` may block ES module / CDN loads. Prefer a local static server (or Netlify / any static host).

## Deploy (static)

Point any static host (Netlify, Cloudflare Pages, GitHub Pages, nginx) at this directory. Publish:

- `index.html`
- `styles.css`
- `app.js`
- `README.md` (optional)

No environment variables or build command required.

### Netlify tip

- Build command: *(leave empty)*
- Publish directory: the folder that contains `index.html`

Cross-Origin Isolation is **not** required for the default `@ffmpeg/ffmpeg` + `@ffmpeg/core` ESM build used here (blob URLs via `@ffmpeg/util`).

## How to use

1. Drop or choose a photo or video.
2. Pick **Fit** or **Fill**, resolution, and (for photos) JPEG/PNG.
3. For videos longer than ~30s, leave **Trim to first 30s** on (Status default), or uncheck to keep more (WhatsApp may still limit).
4. Tap **Download** and share the file to WhatsApp Status.

## Tech

| Piece | Approach |
|--------|----------|
| Photos | Canvas 2D, `createImageBitmap` when available |
| Videos | `@ffmpeg/ffmpeg` + `@ffmpeg/core` + `@ffmpeg/util` from jsDelivr CDN |
| UI | Vanilla HTML / CSS / JS |

First video export downloads the ffmpeg wasm core (~25–30 MB); photos work offline after the page and fonts are cached.

## Caveats

- **HEIC/HEIF** decoding depends on the browser (often Safari). Others should convert to JPEG/PNG first.
- Video encoding is CPU-heavy in-browser; large/long clips can take a while.
- Blur pad on video uses an ffmpeg filter graph; if it fails, the app retries with a solid black pad.
- Preview for video approximates Fit/Fill with CSS `object-fit`; the exported file uses exact scale/crop/pad.

## License

Personal / internal use for Joe Kays. No warranty.
