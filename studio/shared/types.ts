// types.ts — FROZEN shared contract for studio v2. Imported by BOTH web/ and
// server/ (relative path). Do not change shapes without bumping the contract.
//
// All transforms are in PRINT-DOT space (canvas = preset.widthPx x heightPx),
// identical to Editor.tsx ImageTransform, so a saved template reprints
// pixel-identically. NEVER store screen-space (viewScale) coordinates here.

export type DitherMode = 'threshold' | 'floyd-steinberg' | 'none';

// Knobs that affect the burned label. density+gapMm map 1:1 onto tspl.ts TsplOpts.
export interface PrinterSettings {
  density: number; // TSPL DENSITY 0-15 (darkness)
  gapMm: number; // label gap height, mm, 0-25
  dither: DitherMode;
  threshold: number; // 0-255, used when dither === 'threshold'
}

export interface Settings extends PrinterSettings {
  version: 1;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  density: 12,
  gapMm: 2,
  dither: 'threshold',
  threshold: 128,
  updatedAt: 0,
};

export interface AssetMeta {
  id: string; // `${Date.now().toString(36)}-${hex8}` (sortable)
  name: string; // user-facing label (defaults to original filename)
  ext: string; // 'png' | 'jpeg' | 'webp' | ... (from sharp meta.format)
  mime: string; // 'image/png' etc.
  bytes: number; // original byte size
  width: number; // natural px
  height: number; // natural px
  createdAt: number;
}

// A placed asset; transform in DOT space (matches Editor.ImageTransform exactly).
export interface TemplateItem {
  assetId: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number; // degrees
}

// v2 scope: ONE placed asset per template (single-image editor). `item` may be
// null for an empty/size-only template. (Multi-layer is a future enhancement;
// keep this single-item to match the editor.)
export interface Template {
  id: string;
  name: string;
  presetId: string; // references PRESETS[].id (validate via getPreset)
  item: TemplateItem | null;
  settings: Partial<PrinterSettings>; // per-template overrides; missing keys fall back to global Settings
  createdAt: number;
  updatedAt: number;
}

// ---- Wire types -------------------------------------------------------------
export interface PrintBody {
  presetId: string;
  copies: number;
  dither: DitherMode;
  threshold: number;
  pngBase64: string;
  density?: number; // optional override (0-15); falls back to persisted Settings
  gapMm?: number; // optional override (0-25); falls back to persisted Settings
  templateId?: string; // optional provenance only
}

export interface PrintResult {
  jobId: string;
  previewPngBase64: string;
}

export type JobState = 'pending' | 'processing' | 'completed' | 'error';
export interface JobStatus {
  state: JobState;
  message?: string;
}

export interface CreateAssetBody {
  name: string;
  pngBase64: string; // data-URL or bare base64; any sharp-decodable image
}

export interface CreateTemplateBody {
  name: string;
  presetId: string;
  item: TemplateItem | null;
  settings?: Partial<PrinterSettings>;
}
