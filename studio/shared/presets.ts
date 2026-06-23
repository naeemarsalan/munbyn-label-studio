// SINGLE SOURCE OF TRUTH for label sizes and the mm<->dot math.
// Imported by BOTH the frontend (studio/web) and backend (studio/server) so
// physical dimensions can never drift between the editor and the print job.
// The printer is 203 dpi (8 dots/mm). Do NOT change DPI without re-validating.

export const DPI = 203;

// Print-head physical limit: PPD ParamCustomPageSize width max = 294pt ~= 103.7mm.
export const MAX_WIDTH_MM = 103.7;

/** millimetres -> printer dots, rounded to nearest dot */
export const mmToPx = (mm: number): number => Math.round((mm * DPI) / 25.4);

/** round a dot count up to a multiple of 8 (one byte per 8 dots on the head) */
export const align8 = (px: number): number => Math.ceil(px / 8) * 8;

export type Preset = {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
  /** export width in dots, byte-aligned to a multiple of 8 */
  widthPx: number;
  /** export height in dots */
  heightPx: number;
};

const make = (id: string, label: string, widthMm: number, heightMm: number): Preset => ({
  id,
  label,
  widthMm,
  heightMm,
  widthPx: align8(mmToPx(widthMm)),
  heightPx: mmToPx(heightMm),
});

// Common direct-thermal label sizes for the Munbyn ITPP941 (4" head).
export const PRESETS: Preset[] = [
  make('100x150', '100 × 150 mm  (4×6")', 100, 150),
  make('100x100', '100 × 100 mm', 100, 100),
  make('100x50', '100 × 50 mm', 100, 50),
  make('75x50', '75 × 50 mm', 75, 50),
  make('50x50', '50 × 50 mm', 50, 50),
  make('50x30', '50 × 30 mm', 50, 30),
  make('40x30', '40 × 30 mm', 40, 30),
  make('30x20', '30 × 20 mm', 30, 20),
];

export const getPreset = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);
