// store.ts — all /data persistence for studio v2.
//
// Layout under DATA_DIR (default "/data", dev fallback "./.data"):
//   assets/<id>.<ext>   original uploaded bytes
//   assets/<id>.json    AssetMeta sidecar
//   thumbs/<id>.webp    256px fit:inside webp thumbnail
//   templates/<id>.json Template
//   settings.json       Settings
//   .tmp/<rand>         scratch files for atomic writes
//
// All writes are serialized through one internal async lock (a promise chain)
// and use write-temp-then-rename for atomicity. Reads come from in-memory Maps
// populated on init().

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import {
  type AssetMeta,
  type Template,
  type Settings,
  type PrinterSettings,
  type DitherMode,
  type CreateTemplateBody,
  type TemplateItem,
  DEFAULT_SETTINGS,
} from '../../shared/types';
import { getPreset } from '../../shared/presets';

// ---- Error type -----------------------------------------------------------

export type StoreErrorCode = 'IN_USE' | 'NOT_FOUND' | 'BAD_INPUT';

export class StoreError extends Error {
  code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

// ---- Paths ----------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : './.data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const TMP_DIR = path.join(DATA_DIR, '.tmp');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---- IDs ------------------------------------------------------------------

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

// ---- Write lock (single serialized chain) ---------------------------------

let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---- Atomic write helpers -------------------------------------------------

async function atomicWrite(dest: string, data: Buffer | string): Promise<void> {
  const tmp = path.join(TMP_DIR, randomBytes(8).toString('hex'));
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, dest);
}

async function writeJson(dest: string, value: unknown): Promise<void> {
  await atomicWrite(dest, JSON.stringify(value, null, 2));
}

// ---- In-memory state ------------------------------------------------------

const assetMap = new Map<string, AssetMeta>();
const templateMap = new Map<string, Template>();
let settings: Settings = { ...DEFAULT_SETTINGS };

// ---- Format / mime helpers ------------------------------------------------

function mimeFor(format: string): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'tiff':
      return 'image/tiff';
    case 'svg':
      return 'image/svg+xml';
    default:
      return `image/${format}`;
  }
}

const VALID_DITHER: DitherMode[] = ['threshold', 'floyd-steinberg', 'none'];

function clamp(n: number, lo: number, hi: number, dflt: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ---- Settings sanitization ------------------------------------------------

function sanitizeSettings(base: Settings, partial: Partial<PrinterSettings>): Settings {
  const next: Settings = { ...base };
  if (partial.density !== undefined) {
    next.density = Math.round(clamp(partial.density, 0, 15, base.density));
  }
  if (partial.gapMm !== undefined) {
    next.gapMm = clamp(partial.gapMm, 0, 25, base.gapMm);
  }
  if (partial.threshold !== undefined) {
    next.threshold = Math.round(clamp(partial.threshold, 0, 255, base.threshold));
  }
  if (partial.dither !== undefined) {
    next.dither = VALID_DITHER.includes(partial.dither) ? partial.dither : base.dither;
  }
  return next;
}

// ---- Init -----------------------------------------------------------------

async function init(): Promise<void> {
  for (const dir of [DATA_DIR, ASSETS_DIR, THUMBS_DIR, TEMPLATES_DIR, TMP_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // Load assets: scan assets/*.json sidecars.
  assetMap.clear();
  const assetFiles = await fs.readdir(ASSETS_DIR).catch(() => [] as string[]);
  for (const f of assetFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(ASSETS_DIR, f), 'utf8');
      const meta = JSON.parse(raw) as AssetMeta;
      if (meta && typeof meta.id === 'string') assetMap.set(meta.id, meta);
    } catch {
      /* skip corrupt sidecar */
    }
  }

  // Load templates: scan templates/*.json.
  templateMap.clear();
  const tplFiles = await fs.readdir(TEMPLATES_DIR).catch(() => [] as string[]);
  for (const f of tplFiles) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(TEMPLATES_DIR, f), 'utf8');
      const tpl = JSON.parse(raw) as Template;
      if (tpl && typeof tpl.id === 'string') templateMap.set(tpl.id, tpl);
    } catch {
      /* skip corrupt template */
    }
  }

  // Load or initialize settings.
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed, version: 1 }, parsed);
  } catch {
    settings = { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
    await withLock(() => writeJson(SETTINGS_FILE, settings));
  }
}

// ---- Assets ---------------------------------------------------------------

function listAssets(): AssetMeta[] {
  return [...assetMap.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function getAssetMeta(id: string): AssetMeta | undefined {
  return assetMap.get(id);
}

async function createAsset(name: string, buf: Buffer): Promise<AssetMeta> {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new StoreError('BAD_INPUT', 'Empty image upload.');
  }

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new StoreError('BAD_INPUT', 'Uploaded file is not a decodable image.');
  }
  if (!meta.format || !meta.width || !meta.height) {
    throw new StoreError('BAD_INPUT', 'Uploaded file is not a supported image.');
  }

  const id = newId();
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format;
  const mime = mimeFor(meta.format);

  // Build thumbnail first (so a thumb failure aborts before persisting).
  let thumb: Buffer;
  try {
    thumb = await sharp(buf)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new StoreError('BAD_INPUT', 'Could not generate a thumbnail for this image.');
  }

  const assetMeta: AssetMeta = {
    id,
    name: name && name.trim() ? name.trim() : `image.${ext}`,
    ext,
    mime,
    bytes: buf.length,
    width: meta.width,
    height: meta.height,
    createdAt: Date.now(),
  };

  return withLock(async () => {
    await atomicWrite(path.join(ASSETS_DIR, `${id}.${ext}`), buf);
    await atomicWrite(path.join(THUMBS_DIR, `${id}.webp`), thumb);
    await writeJson(path.join(ASSETS_DIR, `${id}.json`), assetMeta);
    assetMap.set(id, assetMeta);
    return assetMeta;
  });
}

function assetBytesPath(id: string): { path: string; mime: string } {
  const meta = assetMap.get(id);
  if (!meta) throw new StoreError('NOT_FOUND', `Asset "${id}" not found.`);
  return { path: path.join(ASSETS_DIR, `${id}.${meta.ext}`), mime: meta.mime };
}

function assetThumbPath(id: string): string {
  const meta = assetMap.get(id);
  if (!meta) throw new StoreError('NOT_FOUND', `Asset "${id}" not found.`);
  return path.join(THUMBS_DIR, `${id}.webp`);
}

async function removeAsset(id: string): Promise<void> {
  const meta = assetMap.get(id);
  if (!meta) throw new StoreError('NOT_FOUND', `Asset "${id}" not found.`);

  for (const tpl of templateMap.values()) {
    if (tpl.item && tpl.item.assetId === id) {
      throw new StoreError('IN_USE', `Asset "${id}" is used by template "${tpl.id}".`);
    }
  }

  return withLock(async () => {
    await fs.rm(path.join(ASSETS_DIR, `${id}.${meta.ext}`), { force: true });
    await fs.rm(path.join(ASSETS_DIR, `${id}.json`), { force: true });
    await fs.rm(path.join(THUMBS_DIR, `${id}.webp`), { force: true });
    assetMap.delete(id);
  });
}

// ---- Templates ------------------------------------------------------------

function listTemplates(): Template[] {
  return [...templateMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function getTemplate(id: string): Template | undefined {
  return templateMap.get(id);
}

function validateItem(item: TemplateItem | null | undefined): TemplateItem | null {
  if (item === null || item === undefined) return null;
  if (typeof item.assetId !== 'string' || !item.assetId) {
    throw new StoreError('BAD_INPUT', 'item.assetId is required when item is present.');
  }
  if (!assetMap.has(item.assetId)) {
    throw new StoreError('BAD_INPUT', `item.assetId "${item.assetId}" does not exist.`);
  }
  const num = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return {
    assetId: item.assetId,
    x: num(item.x, 0),
    y: num(item.y, 0),
    scaleX: num(item.scaleX, 1),
    scaleY: num(item.scaleY, 1),
    rotation: num(item.rotation, 0),
  };
}

function sanitizePartialSettings(partial: Partial<PrinterSettings> | undefined): Partial<PrinterSettings> {
  if (!partial || typeof partial !== 'object') return {};
  const out: Partial<PrinterSettings> = {};
  if (partial.density !== undefined) out.density = Math.round(clamp(partial.density, 0, 15, 12));
  if (partial.gapMm !== undefined) out.gapMm = clamp(partial.gapMm, 0, 25, 2);
  if (partial.threshold !== undefined) out.threshold = Math.round(clamp(partial.threshold, 0, 255, 128));
  if (partial.dither !== undefined && VALID_DITHER.includes(partial.dither)) out.dither = partial.dither;
  return out;
}

async function createTemplate(body: CreateTemplateBody): Promise<Template> {
  if (!body || typeof body !== 'object') {
    throw new StoreError('BAD_INPUT', 'Missing template body.');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new StoreError('BAD_INPUT', 'Template name is required.');
  }
  if (typeof body.presetId !== 'string' || !getPreset(body.presetId)) {
    throw new StoreError('BAD_INPUT', `Unknown presetId "${body.presetId}".`);
  }
  const item = validateItem(body.item);
  const now = Date.now();
  const tpl: Template = {
    id: newId(),
    name: body.name.trim(),
    presetId: body.presetId,
    item,
    settings: sanitizePartialSettings(body.settings),
    createdAt: now,
    updatedAt: now,
  };

  return withLock(async () => {
    await writeJson(path.join(TEMPLATES_DIR, `${tpl.id}.json`), tpl);
    templateMap.set(tpl.id, tpl);
    return tpl;
  });
}

async function updateTemplate(id: string, body: CreateTemplateBody): Promise<Template> {
  const existing = templateMap.get(id);
  if (!existing) throw new StoreError('NOT_FOUND', `Template "${id}" not found.`);
  if (!body || typeof body !== 'object') {
    throw new StoreError('BAD_INPUT', 'Missing template body.');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new StoreError('BAD_INPUT', 'Template name is required.');
  }
  if (typeof body.presetId !== 'string' || !getPreset(body.presetId)) {
    throw new StoreError('BAD_INPUT', `Unknown presetId "${body.presetId}".`);
  }
  const item = validateItem(body.item);
  const tpl: Template = {
    ...existing,
    name: body.name.trim(),
    presetId: body.presetId,
    item,
    settings: sanitizePartialSettings(body.settings),
    updatedAt: Date.now(),
  };

  return withLock(async () => {
    await writeJson(path.join(TEMPLATES_DIR, `${tpl.id}.json`), tpl);
    templateMap.set(tpl.id, tpl);
    return tpl;
  });
}

async function removeTemplate(id: string): Promise<void> {
  if (!templateMap.has(id)) throw new StoreError('NOT_FOUND', `Template "${id}" not found.`);
  return withLock(async () => {
    await fs.rm(path.join(TEMPLATES_DIR, `${id}.json`), { force: true });
    templateMap.delete(id);
  });
}

// ---- Settings -------------------------------------------------------------

function getSettings(): Settings {
  return { ...settings };
}

async function updateSettings(partial: Partial<PrinterSettings>): Promise<Settings> {
  const next = sanitizeSettings(settings, partial || {});
  next.version = 1;
  next.updatedAt = Date.now();
  return withLock(async () => {
    await writeJson(SETTINGS_FILE, next);
    settings = next;
    return { ...settings };
  });
}

// ---- Public API -----------------------------------------------------------

export const store = {
  init,
  assets: {
    list: listAssets,
    create: createAsset,
    getMeta: getAssetMeta,
    bytesPath: assetBytesPath,
    thumbPath: assetThumbPath,
    remove: removeAsset,
  },
  templates: {
    list: listTemplates,
    get: getTemplate,
    create: createTemplate,
    update: updateTemplate,
    remove: removeTemplate,
  },
  settings: {
    get: getSettings,
    update: updateSettings,
  },
};

export default store;
