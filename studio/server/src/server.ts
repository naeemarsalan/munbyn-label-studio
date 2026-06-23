// server.ts — Fastify app: serves the built SPA and the print API.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { PRESETS, getPreset } from '../../shared/presets';
import { buildTSPL, TsplError, type DitherMode } from './tspl.js';
import { submit, status, deviceOk, type DeviceConfig } from './print.js';
import { store } from './store.js';
import assetsRoutes from './routes.assets.js';
import templatesRoutes from './routes.templates.js';
import settingsRoutes from './routes.settings.js';
import { startRaw9100 } from './net9100.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ---------------------------------------------------------------
const PORT = Number(process.env.PORT) || 8080;
// The printer's kernel USB character device. We write TSPL straight to it.
const PRINTER_DEVICE = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
// WEB_DIST default resolves to studio/web/dist relative to this file (src/).
const WEB_DIST = process.env.WEB_DIST || path.resolve(__dirname, '../../web/dist');

const devCfg: DeviceConfig = { device: PRINTER_DEVICE };

// ---- Single-printer serialization ----------------------------------------
// Chain print submissions so only one write to the device runs at a time. This
// SAME `enqueue` is shared by /api/print and the raw-9100 listener so the
// printer is never driven by two jobs concurrently.
let printChain: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = printChain.then(task, task);
  // Keep the chain alive regardless of individual task outcome.
  printChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Types ----------------------------------------------------------------
interface PrintBody {
  presetId: string;
  copies: number;
  dither: DitherMode;
  threshold: number;
  pngBase64: string;
  density?: number; // optional override (0-15); falls back to persisted Settings
  gapMm?: number; // optional override (0-25); falls back to persisted Settings
  templateId?: string; // provenance only
}

function decodePngBase64(input: string): Buffer {
  // Accept data-URL or bare base64.
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  return Buffer.from(b64, 'base64');
}

// ---- App ------------------------------------------------------------------
const app = Fastify({
  logger: true,
  // Large enough for a base64-encoded full-size PNG (4x6" @ 203dpi).
  bodyLimit: 25 * 1024 * 1024,
});

// API: persistence plugins (assets, templates, settings) ---------------------
await app.register(assetsRoutes);
await app.register(templatesRoutes);
await app.register(settingsRoutes);

// API: presets ---------------------------------------------------------------
app.get('/api/presets', async () => PRESETS);

// API: health ----------------------------------------------------------------
app.get('/healthz', async () => {
  const ready = await deviceOk(devCfg);
  return { ok: true, device: PRINTER_DEVICE, ready };
});

// API: print -----------------------------------------------------------------
app.post<{ Body: PrintBody }>('/api/print', async (req, reply) => {
  const body = req.body ?? ({} as PrintBody);
  const { presetId, copies, dither, threshold, pngBase64 } = body;

  if (typeof presetId !== 'string' || !presetId) {
    return reply.code(400).send({ error: 'Missing presetId.' });
  }
  const preset = getPreset(presetId);
  if (!preset) {
    return reply.code(400).send({ error: `Unknown presetId "${presetId}".` });
  }
  if (typeof pngBase64 !== 'string' || !pngBase64) {
    return reply.code(400).send({ error: 'Missing pngBase64.' });
  }
  // Resolve burn knobs on the SERVER: request overrides win, else persisted Settings.
  const settings = store.settings.get();
  const validDither: DitherMode[] = ['threshold', 'floyd-steinberg', 'none'];
  const mode: DitherMode = validDither.includes(dither) ? dither : settings.dither;
  const thr = Number.isFinite(threshold) ? threshold : settings.threshold;
  const density = Number.isFinite(body.density as number) ? (body.density as number) : settings.density;
  const gapMm = Number.isFinite(body.gapMm as number) ? (body.gapMm as number) : settings.gapMm;
  const nCopies = Math.max(1, Math.floor(Number(copies) || 1));

  let pngBuf: Buffer;
  try {
    pngBuf = decodePngBase64(pngBase64);
  } catch {
    return reply.code(400).send({ error: 'pngBase64 is not valid base64.' });
  }
  if (pngBuf.length === 0) {
    return reply.code(400).send({ error: 'Decoded image is empty.' });
  }

  // Build TSPL (validate + convert). Dimension/oversize problems => 400.
  let built;
  try {
    built = await buildTSPL(pngBuf, preset, {
      dither: mode,
      threshold: thr,
      density,
      gapMm,
      copies: nCopies,
    });
  } catch (err) {
    if (err instanceof TsplError) {
      return reply.code(400).send({ error: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'Failed to build label.' });
  }

  const { tspl, previewPng } = built;

  // Write the raw TSPL stream to a temp file and submit it raw.
  const filePath = path.join(os.tmpdir(), `label-${Date.now()}-${randomBytes(6).toString('hex')}.tspl`);
  await fs.writeFile(filePath, tspl);

  // Submit serialized (one physical printer), always unlink temp file after.
  try {
    const { jobId } = await enqueue(() => submit(filePath, devCfg));
    return reply.code(200).send({
      jobId,
      previewPngBase64: `data:image/png;base64,${previewPng.toString('base64')}`,
    });
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: 'Print submission failed.' });
  } finally {
    fs.unlink(filePath).catch(() => {
      /* best-effort cleanup */
    });
  }
});

// API: job status ------------------------------------------------------------
app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (req, reply) => {
  const { jobId } = req.params;
  if (!jobId) {
    return reply.code(400).send({ error: 'Missing jobId.' });
  }
  try {
    const s = await status(jobId, devCfg);
    return reply.code(200).send(s);
  } catch (err) {
    req.log.error(err);
    return reply.code(200).send({ state: 'error', message: 'Could not query job status.' });
  }
});

// ---- Static SPA ------------------------------------------------------------
async function start() {
  // Initialize persistence (creates dirs, loads assets/templates/settings).
  await store.init();

  let serveStatic = true;
  try {
    await fs.access(WEB_DIST);
  } catch {
    serveStatic = false;
    app.log.warn(`WEB_DIST not found at ${WEB_DIST}; SPA will not be served.`);
  }

  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      index: ['index.html'],
      wildcard: false, // let our notFoundHandler do SPA fallback
    });

    // SPA fallback: any non-/api GET returns index.html.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && req.url !== '/healthz') {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found.' });
    });
  } else {
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.code(404).send({ error: 'Not found.' });
    });
  }

  try {
    await app.listen({ host: '0.0.0.0', port: PORT });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Optional raw-9100 listener, sharing the SAME printer lock as /api/print.
  if (process.env.ENABLE_RAW_9100 === '1') {
    const rawPort = Number(process.env.RAW_9100_PORT) || 9100;
    startRaw9100(rawPort, enqueue);
    app.log.info(`raw-9100 listener enabled on port ${rawPort}`);
  }
}

start();
