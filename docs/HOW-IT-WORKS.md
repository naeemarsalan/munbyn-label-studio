# How it works — driving the Munbyn ITPP941 on Linux

The short version: the ITPP941 is a **TSPL** printer, and you drive it by
generating TSPL and **writing it straight to the kernel USB device
`/dev/usb/lp0`**. CUPS does not work for it. Here's how we got there — including
a wrong turn worth recording so nobody repeats it.

## The wrong turn: "it's ZPL" (it isn't)

The macOS "driver" is a Munbyn fork of CUPS's `rastertolabel` filter + a PPD
(`cupsModelNumber 20`). Dumping strings from the macOS filter binary showed ZPL
commands (`^XA`, `~DG`, `^FO`, `^XZ`), so the first assumption was: *it's a ZPL
printer, use stock CUPS `rastertolabel` in ZPL mode (`cupsModelNumber 18`)*.

We built that (CUPS-in-Docker + the PPD), and every job **"completed" but nothing
printed**. The ZPL strings in the binary are just the stock `rastertolabel` base
it was forked from; Munbyn's `cupsModelNumber 20` code path emits something else.

## Finding the truth: the USB device ID + capturing the real bytes

Two pieces of hard evidence cracked it:

1. **USB IEEE-1284 device id** (`/sys/.../ieee1284_id`):
   ```
   MFG:Munbyn ;CMD:XPP,XL;MDL:ITPP941
   ```
   `CMD:XPP,XL` — the printer advertises Munbyn's languages, **not ZPL/EPL**.

2. **Capturing the working macOS driver's output** (this Mac is x86_64, so its
   filter runs locally). Feeding it a CUPS raster produced:
   ```
   SIZE 100 mm,150 mm
   REFERENCE 0,0
   GAP 2 mm,0 mm
   DENSITY 12
   SETC AUTODOTTED OFF / PAUSEKEY ON / WATERMARK OFF
   BITMAP 0,0,100,1199,1,<1-bit raster>
   PRINT 1,1
   ```
   That is **TSPL** (TSC Printer Language). Replaying these exact bytes to the Pi
   printer produced a correct label. Confirmed.

(BITMAP bit polarity: `1` = white/no-dot, `0` = black/burn. Width is bytes-per-row
= ceil(dots/8).)

## Why CUPS can't drive it

CUPS's modern `usb` backend uses **libusb**, which **detaches the kernel `usblp`
driver** to claim the interface. On this setup the printer then never drains the
data — it prints nothing and eventually **wedges** (subsequent writes block). It
also makes `/dev/usb/lp0` disappear. So CUPS was retired entirely; there is no
`rastertolabel`/ZPL/`cupsModelNumber` in the live system.

## The working architecture

```
browser (studio web UI)
  -> design canvas (Konva), exact label size @203dpi
  -> POST /api/print {presetId, image PNG, density?, gapMm?, ...}
backend (Fastify + sharp)
  -> tspl.ts: PNG -> grayscale -> 1-bit -> TSPL (SIZE/GAP/DENSITY/BITMAP/PRINT)
  -> print.ts: write the TSPL bytes to /dev/usb/lp0 (timeout-guarded)
kernel usblp -> printer
```

- Printer settings (`DENSITY` darkness, `GAP` mm) come from persisted Settings,
  overridable per print / per template (`tspl.ts` already takes `density`/`gapMm`).
- Everything funnels through one in-process lock so only one job hits the device
  at a time (the raw `:9100` socket, when enabled, uses the same lock).

## Operational notes

- **Wedged printer** (writes block / nothing prints): **power-cycle it**, then
  `printf 'SELFTEST\r\n' > /dev/usb/lp0` should print the config page.
- **`/dev/usb/lp0` gone**: nothing must use libusb on the printer. Re-enumerate
  via `/sys/bus/usb/drivers/usb` unbind/bind (see the top-level README).
- The container gets the device via a `/dev/usb` bind mount + `device_cgroup_rules:
  ['c 180:* rmw']` (usblp is char major 180), which survives re-plug.
