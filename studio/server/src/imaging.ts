// imaging.ts — pure image preparation. No fastify/http knowledge.
// Validates a rendered PNG against a preset, converts it to a clean (near-)1-bit
// black-on-white image suitable for the thermal head, and writes it to a temp file.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { Preset } from '../../shared/presets';
import { MAX_WIDTH_MM, DPI } from '../../shared/presets';

export type DitherMode = 'threshold' | 'floyd-steinberg' | 'none';

export interface PrepareOpts {
  dither: DitherMode;
  /** 0-255, used when dither === 'threshold' */
  threshold: number;
}

export interface PrepareResult {
  /** absolute path of the temp PNG to feed to lp */
  filePath: string;
  /** identical pixels as a PNG buffer, for the UI preview */
  previewPng: Buffer;
}

/** Typed error so callers (server.ts) can return a clean 4xx with a useful message. */
export class ImagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagingError';
  }
}

function clampThreshold(t: number): number {
  if (!Number.isFinite(t)) return 128;
  return Math.min(255, Math.max(0, Math.round(t)));
}

/**
 * Floyd–Steinberg error diffusion to 1-bit on a grayscale buffer.
 * `data` is one byte per pixel (grayscale), row-major, length === width*height.
 * Mutates in place, writing 0 or 255 per pixel.
 */
function floydSteinberg(data: Uint8ClampedArray, width: number, height: number): void {
  // Use a float accumulation buffer so diffused error keeps precision.
  const buf = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) buf[i] = data[i];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = buf[idx];
      const newVal = old < 128 ? 0 : 255;
      const err = old - newVal;
      data[idx] = newVal;

      // Distribute error to neighbours (serpentine not needed; classic order).
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
 * Prepare a rendered PNG for printing.
 * Throws ImagingError on dimension mismatch or oversize width.
 */
export async function prepareForPrint(
  pngBuf: Buffer,
  preset: Preset,
  opts: PrepareOpts,
): Promise<PrepareResult> {
  if (preset.widthMm > MAX_WIDTH_MM) {
    throw new ImagingError(
      `Preset width ${preset.widthMm}mm exceeds the print-head maximum of ${MAX_WIDTH_MM}mm.`,
    );
  }

  // Validate the source dimensions BEFORE any processing.
  let meta: sharp.Metadata;
  try {
    meta = await sharp(pngBuf).metadata();
  } catch {
    throw new ImagingError('Could not decode the uploaded PNG image.');
  }
  if (meta.width !== preset.widthPx || meta.height !== preset.heightPx) {
    throw new ImagingError(
      `Image dimensions ${meta.width ?? '?'}×${meta.height ?? '?'} do not match preset ` +
        `"${preset.id}" (${preset.widthPx}×${preset.heightPx}). The client must render at exact pixel size.`,
    );
  }

  const width = preset.widthPx;
  const height = preset.heightPx;

  // Flatten transparency onto white (thermal = black on white) and go grayscale.
  const grayBase = sharp(pngBuf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale();

  let outPng: Buffer;

  if (opts.dither === 'none') {
    // Grayscale only — let CUPS threshold downstream.
    // Stamp 203 DPI so the printer renders the page at exactly the label size
    // (CUPS maps 800px/203dpi = 100mm) instead of assuming ~72dpi and clipping.
    outPng = await grayBase.withMetadata({ density: DPI }).png({ compressionLevel: 9 }).toBuffer();
  } else if (opts.dither === 'threshold') {
    const t = clampThreshold(opts.threshold);
    // Hard threshold to pure black/white. sharp.threshold maps >= t -> 255, else 0.
    outPng = await grayBase
      .threshold(t)
      .withMetadata({ density: DPI })
      .png({ compressionLevel: 9, palette: true, colours: 2 })
      .toBuffer();
  } else {
    // floyd-steinberg: do our own error diffusion for a clean, deterministic 1-bit result.
    const raw = await grayBase.raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    // grayscale raw => 1 channel.
    const channels = info.channels;
    let gray: Uint8ClampedArray;
    if (channels === 1) {
      gray = new Uint8ClampedArray(data);
    } else {
      // Defensive: collapse to single channel if sharp returned >1.
      gray = new Uint8ClampedArray(width * height);
      for (let i = 0, p = 0; i < data.length; i += channels, p++) gray[p] = data[i];
    }

    floydSteinberg(gray, width, height);

    outPng = await sharp(Buffer.from(gray.buffer, gray.byteOffset, gray.byteLength), {
      raw: { width, height, channels: 1 },
    })
      .withMetadata({ density: DPI })
      .png({ compressionLevel: 9, palette: true, colours: 2 })
      .toBuffer();
  }

  // Write to a unique temp file.
  const fileName = `label-${Date.now()}-${randomBytes(6).toString('hex')}.png`;
  const filePath = path.join(os.tmpdir(), fileName);
  await fs.writeFile(filePath, outPng);

  return { filePath, previewPng: outPng };
}
