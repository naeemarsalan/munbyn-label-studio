import type { Preset } from '../../shared/presets';
import type {
  AssetMeta,
  CreateAssetBody,
  CreateTemplateBody,
  DitherMode,
  JobStatus,
  PrintBody,
  PrintResult,
  Settings,
  Template,
} from '../../shared/types';

// Re-export the shared wire/runtime types so existing imports (./api) keep
// working without reaching into ../../shared everywhere.
export type {
  AssetMeta,
  CreateAssetBody,
  CreateTemplateBody,
  DitherMode,
  JobState,
  JobStatus,
  PrintBody,
  PrintResult,
  PrinterSettings,
  Settings,
  Template,
  TemplateItem,
} from '../../shared/types';

// ---- low-level helpers ------------------------------------------------------

async function jsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : '') || `${fallback} (HTTP ${res.status})`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const res = await fetch(url);
  return jsonOrThrow<T>(res, fallback);
}

async function sendJson<T>(
  url: string,
  method: string,
  body: unknown,
  fallback: string
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonOrThrow<T>(res, fallback);
}

// ---- presets ----------------------------------------------------------------

/** GET /api/presets -> Preset[] */
export async function getPresets(): Promise<Preset[]> {
  return getJson<Preset[]>('/api/presets', 'Failed to load presets');
}

// ---- print + jobs -----------------------------------------------------------

/** POST /api/print -> { jobId, previewPngBase64 } */
export async function printLabel(body: PrintBody): Promise<PrintResult> {
  return sendJson<PrintResult>('/api/print', 'POST', body, 'Print failed');
}

/** GET /api/jobs/:id -> { state, message? } */
export async function getJob(id: string): Promise<JobStatus> {
  return getJson<JobStatus>(
    `/api/jobs/${encodeURIComponent(id)}`,
    'Failed to fetch job status'
  );
}

// ---- assets -----------------------------------------------------------------

/** GET /api/assets -> AssetMeta[] */
export async function listAssets(): Promise<AssetMeta[]> {
  return getJson<AssetMeta[]>('/api/assets', 'Failed to load assets');
}

/** POST /api/assets -> AssetMeta */
export async function uploadAsset(
  name: string,
  pngBase64: string
): Promise<AssetMeta> {
  const body: CreateAssetBody = { name, pngBase64 };
  return sendJson<AssetMeta>('/api/assets', 'POST', body, 'Upload failed');
}

/** DELETE /api/assets/:id */
export async function deleteAsset(id: string): Promise<void> {
  const res = await fetch(`/api/assets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    await jsonOrThrow<unknown>(res, 'Delete failed');
  }
}

/** Same-origin URL for the raw asset bytes (use as <img src> / editor load). */
export function assetBytesUrl(id: string): string {
  return `/api/assets/${encodeURIComponent(id)}/bytes`;
}

/** Same-origin URL for a small asset thumbnail. */
export function assetThumbUrl(id: string): string {
  return `/api/assets/${encodeURIComponent(id)}/thumb`;
}

// ---- templates --------------------------------------------------------------

/** GET /api/templates -> Template[] */
export async function listTemplates(): Promise<Template[]> {
  return getJson<Template[]>('/api/templates', 'Failed to load templates');
}

/** GET /api/templates/:id -> Template */
export async function getTemplate(id: string): Promise<Template> {
  return getJson<Template>(
    `/api/templates/${encodeURIComponent(id)}`,
    'Failed to load template'
  );
}

/** POST /api/templates -> Template */
export async function createTemplate(body: CreateTemplateBody): Promise<Template> {
  return sendJson<Template>('/api/templates', 'POST', body, 'Save template failed');
}

/** PUT /api/templates/:id -> Template */
export async function updateTemplate(
  id: string,
  body: Partial<CreateTemplateBody>
): Promise<Template> {
  return sendJson<Template>(
    `/api/templates/${encodeURIComponent(id)}`,
    'PUT',
    body,
    'Update template failed'
  );
}

/** DELETE /api/templates/:id */
export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    await jsonOrThrow<unknown>(res, 'Delete template failed');
  }
}

// ---- settings ---------------------------------------------------------------

/** GET /api/settings -> Settings */
export async function getSettings(): Promise<Settings> {
  return getJson<Settings>('/api/settings', 'Failed to load settings');
}

/** PUT /api/settings -> Settings */
export async function putSettings(
  partial: Partial<Pick<Settings, 'density' | 'gapMm' | 'dither' | 'threshold'>>
): Promise<Settings> {
  return sendJson<Settings>('/api/settings', 'PUT', partial, 'Save settings failed');
}

// Keep a named DitherMode value import alive for consumers that only want the
// type via `import { type DitherMode } from './api'`.
export type { DitherMode as DitherModeAlias };
