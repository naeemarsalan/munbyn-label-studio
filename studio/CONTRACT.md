# Label Studio — frozen build contract

Every component is built against THIS document. Do not deviate. If something here
is impossible, stop and flag it rather than inventing a different shape.

## Goal
A lightweight self-hosted web app to design a label from an uploaded image
(size presets, free transform) and print it to the existing Munbyn ITPP941 CUPS
queue. Runs as a second container next to `munbyn-cups` on a Raspberry Pi (arm64).

## Repo layout (who owns what)
```
studio/
  shared/presets.ts        # FROZEN. Source of truth for sizes + mm<->dot math. (already written)
  CONTRACT.md              # this file
  web/                     # OWNER: frontend agent  — React + Vite + TypeScript + Konva SPA
  server/                  # OWNER: backend agent   — Node 20 + Fastify + sharp + lp
  Dockerfile               # OWNER: infra agent     — multi-stage arm64 image
  deploy-studio.sh         # OWNER: infra agent     — build-on-Pi + push helper
  README.md                # OWNER: infra agent     — usage docs
```
`docker-compose.yml` (repo root) is edited by the orchestrator, NOT by agents.

## Shared module
Both sides import the frozen `studio/shared/presets.ts`:
`PRESETS: Preset[]`, `Preset`, `DPI=203`, `mmToPx`, `align8`, `MAX_WIDTH_MM=103.7`, `getPreset`.
- Frontend imports it with a relative path (e.g. `../../shared/presets`); `vite build` bundles it.
- Backend imports it with a relative path and its tsconfig `include`s `../shared`.

## HTTP API (backend serves SPA + these routes)
- `GET  /api/presets` → `Preset[]` (returns the shared PRESETS array).
- `POST /api/print`
  - body: `{ presetId: string; copies: number; dither: 'threshold'|'floyd-steinberg'|'none'; threshold: number; pngBase64: string }`
    - `pngBase64` is a data-URL-or-bare base64 PNG, already rendered at exactly `preset.widthPx × preset.heightPx`.
    - `threshold` 0–255 (used when `dither==='threshold'`).
  - 200 → `{ jobId: string; previewPngBase64: string }`  (preview = the actual 1-bit image that will be burned)
  - 4xx → `{ error: string }`  (dimension mismatch, width>MAX_WIDTH_MM, bad input)
- `GET  /api/jobs/:jobId` → `{ state: 'pending'|'processing'|'completed'|'error'; message?: string }`
- `GET  /healthz` → `{ ok: boolean; cups: boolean }` (cups=true if `lpstat -r` succeeds)
- `GET  /*` → SPA fallback (serve index.html).

## Print path (backend)
1. Decode `pngBase64`, validate dims === `preset.widthPx × preset.heightPx` (else 400).
2. `sharp`: force grayscale; then 1-bit conversion:
   - `threshold` → hard threshold at `threshold` (default 128). Best for line art / barcodes / text.
   - `floyd-steinberg` → error-diffusion dither (photos).
   - `none` → leave grayscale (let CUPS threshold).
   Output a clean PNG to a temp file; also keep a preview PNG buffer.
3. Submit:
   `lp -d <PRINTER_QUEUE> -o media=Custom.<widthMm>x<heightMm>mm -o print-scaling=none -o Resolution=203dpi -n <copies> <tmp.png>`
   with env `CUPS_SERVER=<CUPS_SERVER>`.
   NEVER pass fit-to-page / fitplot / scaling / landscape / orientation options.
4. Parse `request id is <QUEUE>-<NNN>` → `jobId`. Unlink the temp file after `lp` returns.
5. `GET /api/jobs/:id` maps `lpstat -W not-completed`/`-W completed` to state.

## Environment (backend)
- `PORT` (default `8080`)
- `CUPS_SERVER` (default `munbyn-cups:631`)  — reaches the sibling CUPS container over the compose network
- `PRINTER_QUEUE` (default `Munbyn_ITPP941`)

## Frontend behaviour
- Preset switcher (from `GET /api/presets` or the shared module): sets the on-screen artboard to the
  preset's aspect ratio; a white rect = label bounds and CLIPS overflow.
- Image upload (`<input type=file>` + FileReader → `Konva.Image`).
- Free transform via `Konva.Transformer` (move/scale/rotate). "Scale to fit" button.
- Print panel: copies (int ≥1), dither mode select, threshold slider (shown when dither=threshold).
- On Print: render an OFFSCREEN `Konva.Stage` sized exactly `preset.widthPx × preset.heightPx`
  (`pixelRatio:1`), `toDataURL('image/png')`, POST to `/api/print`, then show returned preview + poll job.
- Keep it lightweight and clean; no auth.

## Non-negotiable correctness rules
- Export pixels come from `preset.widthPx/heightPx` (already byte-aligned). No client-side resampling.
- `media=Custom.WxHmm` must match the preset's mm exactly; always `print-scaling=none`.
- Reject `widthMm > MAX_WIDTH_MM` server-side.
- Single physical printer: serialize print submissions; clean up temp files.
