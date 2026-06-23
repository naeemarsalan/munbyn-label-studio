import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { Preset } from '../../shared/presets';
import { MAX_WIDTH_MM } from '../../shared/presets';
import type { DitherMode, Settings } from '../../shared/types';
import { printLabel, getJob } from './api';
import type { ExportResult } from './Editor';

type Props = {
  preset: Preset;
  hasImage: boolean;
  exportPrintPng: () => ExportResult | null;
  /** Persisted defaults; used to prefill the per-print controls. */
  settings: Settings | null;
  /** Provenance for the current print (set when a template is loaded). */
  templateId?: string | null;
};

export type PrintPanelHandle = {
  /** Programmatic print using the current control values (for Quick print). */
  print: () => Promise<void>;
};

type UiState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'tracking'; jobId: string; state: string; message?: string }
  | { kind: 'error'; message: string };

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

const PrintPanel = forwardRef<PrintPanelHandle, Props>(function PrintPanel(
  { preset, hasImage, exportPrintPng, settings, templateId },
  ref
) {
  const [copies, setCopies] = useState(1);
  const [dither, setDither] = useState<DitherMode>('threshold');
  const [threshold, setThreshold] = useState(128);
  const [density, setDensity] = useState(12);
  const [gapMm, setGapMm] = useState(2);
  const [ui, setUi] = useState<UiState>({ kind: 'idle' });
  const [preview, setPreview] = useState<string | null>(null);
  // Track whether the user has manually touched controls; if not, keep mirroring
  // the persisted settings as they load/change.
  const [touched, setTouched] = useState(false);

  const pollTimer = useRef<number | null>(null);

  const overWidth = preset.widthMm > MAX_WIDTH_MM;

  // Prefill from persisted settings until the user overrides anything.
  useEffect(() => {
    if (!settings || touched) return;
    setDither(settings.dither);
    setThreshold(settings.threshold);
    setDensity(settings.density);
    setGapMm(settings.gapMm);
  }, [settings, touched]);

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, []);

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = (jobId: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const s = await getJob(jobId);
        setUi({ kind: 'tracking', jobId, state: s.state, message: s.message });
        if (s.state === 'completed' || s.state === 'error') {
          stopPolling();
          return;
        }
      } catch (err) {
        setUi({
          kind: 'tracking',
          jobId,
          state: 'error',
          message: err instanceof Error ? err.message : 'Polling failed',
        });
        stopPolling();
        return;
      }
      pollTimer.current = window.setTimeout(tick, 1200);
    };
    void tick();
  };

  const doPrint = async () => {
    if (!hasImage) {
      setUi({ kind: 'error', message: 'Upload an image first.' });
      return;
    }
    if (overWidth) {
      setUi({
        kind: 'error',
        message: `Label width ${preset.widthMm} mm exceeds the printer maximum of ${MAX_WIDTH_MM} mm.`,
      });
      return;
    }

    const exported = exportPrintPng();
    if (!exported) {
      setUi({ kind: 'error', message: 'Nothing to print.' });
      return;
    }

    stopPolling();
    setPreview(null);
    setUi({ kind: 'submitting' });

    try {
      const result = await printLabel({
        presetId: preset.id,
        copies: Math.max(1, Math.floor(copies) || 1),
        dither,
        threshold,
        density: clamp(Math.round(density), 0, 15),
        gapMm: clamp(gapMm, 0, 25),
        pngBase64: exported.pngBase64,
        ...(templateId ? { templateId } : {}),
      });
      setPreview(result.previewPngBase64);
      setUi({ kind: 'tracking', jobId: result.jobId, state: 'pending' });
      poll(result.jobId);
    } catch (err) {
      setUi({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Print request failed.',
      });
    }
  };

  useImperativeHandle(ref, (): PrintPanelHandle => ({ print: doPrint }), [
    doPrint,
  ]);

  const printing = ui.kind === 'submitting';

  return (
    <div className="print-panel panel">
      <h2 className="panel-title">Print</h2>

      <label className="field">
        <span>Copies</span>
        <input
          type="number"
          min={1}
          step={1}
          value={copies}
          onChange={(e) =>
            setCopies(Math.max(1, Math.floor(Number(e.target.value) || 1)))
          }
        />
      </label>

      <label className="field">
        <span>
          Density <span className="muted">({density})</span>
        </span>
        <input
          type="range"
          min={0}
          max={15}
          step={1}
          value={density}
          onChange={(e) => {
            setTouched(true);
            setDensity(clamp(Math.round(Number(e.target.value) || 0), 0, 15));
          }}
        />
      </label>

      <label className="field">
        <span>Gap (mm)</span>
        <input
          type="number"
          min={0}
          max={25}
          step={0.5}
          value={gapMm}
          onChange={(e) => {
            setTouched(true);
            setGapMm(clamp(Number(e.target.value) || 0, 0, 25));
          }}
        />
      </label>

      <label className="field">
        <span>Dither</span>
        <select
          value={dither}
          onChange={(e) => {
            setTouched(true);
            setDither(e.target.value as DitherMode);
          }}
        >
          <option value="threshold">Threshold (line art / text)</option>
          <option value="floyd-steinberg">Floyd–Steinberg (photos)</option>
          <option value="none">None</option>
        </select>
      </label>

      {dither === 'threshold' && (
        <label className="field">
          <span>
            Threshold <span className="muted">({threshold})</span>
          </span>
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={threshold}
            onChange={(e) => {
              setTouched(true);
              setThreshold(clamp(Number(e.target.value) || 0, 0, 255));
            }}
          />
        </label>
      )}

      {overWidth && (
        <div className="status status-error">
          Width {preset.widthMm} mm exceeds max {MAX_WIDTH_MM} mm.
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={doPrint}
        disabled={printing || !hasImage || overWidth}
      >
        {printing ? 'Submitting…' : 'Print'}
      </button>

      <div className="status-area">
        {ui.kind === 'error' && (
          <div className="status status-error">{ui.message}</div>
        )}
        {ui.kind === 'submitting' && (
          <div className="status">Rendering &amp; submitting…</div>
        )}
        {ui.kind === 'tracking' && (
          <div
            className={
              'status ' +
              (ui.state === 'completed'
                ? 'status-ok'
                : ui.state === 'error'
                ? 'status-error'
                : '')
            }
          >
            <strong>Job {ui.jobId}</strong> — {ui.state}
            {ui.message ? `: ${ui.message}` : ''}
          </div>
        )}

        {preview && (
          <div className="preview">
            <div className="preview-label">1-bit preview</div>
            <img
              className="preview-img"
              src={
                preview.startsWith('data:')
                  ? preview
                  : `data:image/png;base64,${preview}`
              }
              alt="1-bit print preview"
            />
          </div>
        )}
      </div>
    </div>
  );
});

export default PrintPanel;
