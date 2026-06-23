// tspl.ts — convert a rendered PNG into TSPL/TSC commands for the Munbyn ITPP941.
//
// The ITPP941 does NOT speak ZPL. Its USB IEEE-1284 ID is CMD:XPP,XL and the
// working macOS driver emits TSPL. We reproduce that exact command sequence:
//
//   SIZE <W> mm,<H> mm
//   REFERENCE 0,0
//   GAP <g> mm,0 mm
//   DENSITY <d>
//   SETC AUTODOTTED OFF / PAUSEKEY ON / WATERMARK OFF
//   BITMAP 0,0,<bytesPerRow>,<height>,1,<1-bit raster>
//   PRINT 1,1
//
// TSPL BITMAP bit polarity: 1 = no dot (white), 0 = dot (black/burn).

import sharp from 'sharp';
import type { Preset } from '../../shared/presets';
import { MAX_WIDTH_MM } from '../../shared/presets';

export type DitherMode = 'threshold' | 'floyd-steinberg' | 'none';

export interface TsplOpts {
  dither: DitherMode;
  threshold: number; // 0-255, used when dither === 'threshold'
  density?: number; // TSPL DENSITY 0-15 (darkness); default 12 (matches macOS)
  gapMm?: number; // label gap height in mm; default 2
  copies?: number; // number of labels; default 1
}

export interface TsplResult {
  tspl: Buffer; // raw bytes to send to the printer (lp -o raw)
  previewPng: Buffer; // the exact 1-bit image that will burn, for the UI
}

export class TsplError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TsplError';
  }
}

function clamp(n: number, lo: number, hi: number, dflt: number): number {
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Floyd–Steinberg error diffusion to 0/255 in place. */
function floydSteinberg(data: Uint8ClampedArray, width: number, height: number): void {
  const buf = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) buf[i] = data[i];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldV = buf[idx];
      const newV = oldV < 128 ? 0 : 255;
      const err = oldV - newV;
      data[idx] = newV;
      if (x + 1 < width) buf[idx + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x - 1 >= 0) buf[idx + width - 1] += (err * 3) / 16;
        buf[idx + width] += (err * 5) / 16;
        if (x + 1 < width) buf[idx + width + 1] += (err * 1) / 16;
      }
    }
  }
}

/**
 * Build TSPL for a rendered PNG. Throws TsplError on dimension/oversize problems.
 */
export async function buildTSPL(
  pngBuf: Buffer,
  preset: Preset,
  opts: TsplOpts,
): Promise<TsplResult> {
  if (preset.widthMm > MAX_WIDTH_MM) {
    throw new TsplError(
      `Preset width ${preset.widthMm}mm exceeds the print-head maximum of ${MAX_WIDTH_MM}mm.`,
    );
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(pngBuf).metadata();
  } catch {
    throw new TsplError('Could not decode the uploaded PNG image.');
  }
  if (meta.width !== preset.widthPx || meta.height !== preset.heightPx) {
    throw new TsplError(
      `Image dimensions ${meta.width ?? '?'}×${meta.height ?? '?'} do not match preset ` +
        `"${preset.id}" (${preset.widthPx}×${preset.heightPx}).`,
    );
  }

  const width = preset.widthPx; // multiple of 8 (see presets.align8)
  const height = preset.heightPx;

  // Flatten transparency onto white, go grayscale, get raw 1-channel bytes.
  const { data } = await sharp(pngBuf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Collapse to a single channel just in case, into a 0..255 mono buffer.
  const mono = new Uint8ClampedArray(width * height);
  if (data.length === width * height) {
    mono.set(data);
  } else {
    const ch = Math.round(data.length / (width * height)) || 1;
    for (let i = 0, p = 0; p < mono.length; i += ch, p++) mono[p] = data[i];
  }

  // Reduce to pure black/white (0/255).
  if (opts.dither === 'floyd-steinberg') {
    floydSteinberg(mono, width, height);
  } else if (opts.dither === 'none') {
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i] < 128 ? 0 : 255;
  } else {
    const t = clamp(opts.threshold, 0, 255, 128);
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i] < t ? 0 : 255;
  }

  // Pack to TSPL bitmap: 1 bit/pixel, MSB first. bit 1 = white, 0 = black.
  const bytesPerRow = width >> 3; // width is a multiple of 8
  const bitmap = Buffer.alloc(bytesPerRow * height, 0xff); // default white
  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerRow;
    const srcOff = y * width;
    for (let x = 0; x < width; x++) {
      if (mono[srcOff + x] < 128) {
        // black dot -> clear the bit
        bitmap[rowOff + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }

  const density = clamp(opts.density ?? 12, 0, 15, 12);
  const gap = clamp(opts.gapMm ?? 2, 0, 25, 2);

  const header = Buffer.from(
    `SIZE ${preset.widthMm} mm,${preset.heightMm} mm\r\n` +
      `REFERENCE 0,0\r\n` +
      `GAP ${gap} mm,0 mm\r\n` +
      `DENSITY ${density}\r\n` +
      `SETC AUTODOTTED OFF\r\n` +
      `SETC PAUSEKEY ON\r\n` +
      `SETC WATERMARK OFF\r\n` +
      `BITMAP 0,0,${bytesPerRow},${height},1,`,
    'latin1',
  );
  const copies = clamp(opts.copies ?? 1, 1, 999, 1);
  const tail = Buffer.from(`\nPRINT 1,${copies}\r\n`, 'latin1');
  const lead = Buffer.alloc(192, 0x00); // match the macOS driver's preamble
  const tspl = Buffer.concat([lead, header, bitmap, tail]);

  // Build a preview PNG of exactly what will print (black on white).
  const previewPng = await sharp(Buffer.from(mono.buffer, mono.byteOffset, mono.byteLength), {
    raw: { width, height, channels: 1 },
  })
    .png({ compressionLevel: 9, palette: true, colours: 2 })
    .toBuffer();

  return { tspl, previewPng };
}
