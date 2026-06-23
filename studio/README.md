# Munbyn Label Studio (v2)

A lightweight, self-hosted web app for designing labels and printing them to a
**Munbyn ITPP941** thermal printer at its native **203 dpi** (8 dots/mm) with no
scaling or fit-to-page distortion.

You build a label on a fixed-size canvas (one of the size presets), drop in images
from a reusable **asset library**, free-transform them (move / scale / rotate) with
**snapping**, save reusable **templates**, tune how the design is converted to
1-bit, and print. What you place on the canvas is exactly what comes out of the
head, at true physical size.

## Architecture — TSPL straight to the kernel device

The ITPP941 is a **TSPL** printer (USB IEEE-1284 id `CMD:XPP,XL`), **not** ZPL.
CUPS cannot drive it reliably — its libusb backend detaches the kernel `usblp`
driver and wedges the printer. So there is **no CUPS and no ZPL** anywhere in the
print path. The server generates **TSPL itself** and writes it **raw** to the
kernel character device `/dev/usb/lp0`.

```
Browser ──HTTP──> label-studio (Fastify + sharp)
                       │  PNG -> 1-bit -> TSPL  (tspl.ts)
                       ▼
                  raw bytes to /dev/usb/lp0  ──USB──> Munbyn ITPP941
```

The server renders the design to exactly the preset's byte-aligned pixel size,
converts it to 1-bit, and emits TSPL with these knobs:
`dither`, `threshold`, `density` (0–15), `gapMm` (0–25) and `copies`. No raster
filter, no `lp`, no orientation/scaling options — that's what keeps labels
dimensionally exact.

`/dev/usb/lp0` must exist on the host (the `usblp` driver provides it when the
printer is plugged in). Nothing else may claim the USB interface, or `usblp`
detaches — that's why the old CUPS container is retired.

## What's in here

```
studio/
  shared/
    types.ts          Frozen contracts (templates, transforms, settings)
    presets.ts        Single source of truth: sizes + mm<->dot math (FROZEN)
  web/                React + Vite + TypeScript + Konva SPA  (built to web/dist)
  server/             Node 20 + Fastify + sharp; runs under tsx (no build step)
  Dockerfile          Multi-stage arm64 image (build SPA, then tsx runtime)
  deploy-studio.sh    Build-on-Pi + push helper
```

The frontend and backend both import `shared/presets.ts` and `shared/types.ts`,
so the editor's pixel dimensions, transforms and the print job can never drift
apart. Transforms saved in templates are always in **print-dot space**
(canvas = `preset.widthPx × heightPx`) — never screen-space view coordinates.

## Features

- **Asset library** — upload images once, reuse them across designs; stored on
  the server under `DATA_DIR`.
- **Templates** — save a full label layout (preset + placed assets + transforms +
  print options) and reload it later. Transforms persist in print-dot space.
- **Free transform with snapping** — move, scale and rotate placed images; edges
  and centers snap to the canvas for clean alignment.
- **Printer settings overrides** — per-job / saved overrides for the 1-bit
  conversion and print: `dither`, `threshold`, `density` (0–15), `gapMm`
  (0–25 mm) and `copies`.
- **Size presets** — fixed physical canvases at true 203 dpi (see below).

## Persistence

All saved state lives under **`DATA_DIR`** (default `/data` in the container,
dev fallback `./.data`). In production this is the named Docker volume
**`munbyn-data`**, so rebuilding/redeploying the image never wipes saved work.

What persists:

- **assets/** — uploaded images for the asset library
- **templates/** — saved label layouts
- **settings** — saved printer/conversion overrides

## Build & deploy

The Pi is arm64, so the image is built **on the Pi** to avoid cross-arch builds.
`deploy-studio.sh` ships the `studio/` directory over SSH, builds remotely, and
pushes to the registry. Data survives across deploys in the `munbyn-data` volume.

```bash
cd studio
./deploy-studio.sh
```

Override any of these via environment variables:

| Var          | Default                                     | Purpose                       |
| ------------ | ------------------------------------------- | ----------------------------- |
| `HOST`       | `anaeem@<rpi-ip>`                           | SSH target (the Pi)           |
| `REMOTE_DIR` | `~/munbyn-studio`                           | Where the context is unpacked |
| `IMAGE`      | `oci.arsalan.io/munbyn/label-studio:latest` | Image tag to build and push   |
| `REGISTRY`   | `oci.arsalan.io`                            | Registry for `docker login`   |
| `REG_USER`   | `admin`                                     | Registry user                 |
| `REG_PASS`   | (from env / script default)                 | Registry password             |

After it pushes, bring it up on the Pi via Compose:

```bash
docker compose pull
docker compose up -d
```

To build the image by hand (context **must** be the `studio/` dir):

```bash
cd studio
docker build -t oci.arsalan.io/munbyn/label-studio:latest .
```

## Runtime environment

| Var               | Default          | Purpose                                                              |
| ----------------- | ---------------- | ------------------------------------------------------------------- |
| `PORT`            | `8080`           | HTTP port the app listens on (`0.0.0.0`)                            |
| `PRINTER_DEVICE`  | `/dev/usb/lp0`   | Kernel character device the TSPL bytes are written to               |
| `DATA_DIR`        | `/data`          | Persistence dir for assets / templates / settings                   |
| `ENABLE_RAW_9100` | (unset)          | Set to `1` to expose the optional raw-TSPL socket on `:9100` (below) |
| `WEB_DIST`        | `/app/web/dist`  | Built SPA served by the backend (set in the image)                  |

## Optional raw TSPL socket (port 9100)

The compose file ships a **commented-out** `9100:9100` port mapping and a
commented `ENABLE_RAW_9100: "1"` env. Uncomment both to expose a raw socket that
**forwards bytes straight to `/dev/usb/lp0`**.

This is **only** for sending **raw TSPL** (e.g. a known-good `.tspl` dump or a
device that already speaks TSPL). It is **not** a generic print queue: it does
**not** accept images, PDFs, ZPL, or the app's design jobs, and it does no
raster→TSPL conversion. Leave it disabled unless you specifically need to pipe
raw TSPL. Normal printing always goes through the web app on `:8080`.

## Size presets

Defined in `shared/presets.ts`. Width is byte-aligned to a multiple of 8 dots;
all sizes are at 203 dpi (8 dots/mm). Max printable width is **103.7 mm** (4" head).

| Preset    | Size                |
| --------- | ------------------- |
| `100x150` | 100 × 150 mm (4×6") |
| `100x100` | 100 × 100 mm        |
| `100x50`  | 100 × 50 mm         |
| `75x50`   | 75 × 50 mm          |
| `50x50`   | 50 × 50 mm          |
| `50x30`   | 50 × 30 mm          |
| `40x30`   | 40 × 30 mm          |
| `30x20`   | 30 × 20 mm          |

## Open it

Once the container is up:

```
http://<rpi-ip>:8080
```

## Requirements / notes

- The **Munbyn ITPP941 must be plugged in** so the host exposes `/dev/usb/lp0`,
  and **nothing else may claim the USB interface** (no CUPS / libusb backend), or
  `usblp` detaches and the printer wedges.
- `GET /healthz` reports `{ ok, device, ready }`; `ready` is true when the printer
  device is writable — a quick way to confirm the studio can reach the printer.
- No authentication — keep it on a trusted LAN.
```
