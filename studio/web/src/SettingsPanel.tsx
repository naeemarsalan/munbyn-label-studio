import { useEffect, useState } from 'react';
import type { DitherMode, Settings } from '../../shared/types';
import { getSettings, putSettings } from './api';

type Props = {
  /** Lift the loaded/saved settings to App so PrintPanel can prefill. */
  onSettings: (s: Settings) => void;
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(n)));

export default function SettingsPanel({ onSettings }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        onSettings(s);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load settings.');
      });
    return () => {
      cancelled = true;
    };
    // onSettings is stable enough from App (useCallback); load once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (p: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...p } : prev));
  };

  const onSave = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await putSettings({
        density: settings.density,
        gapMm: settings.gapMm,
        dither: settings.dither,
        threshold: settings.threshold,
      });
      setSettings(next);
      onSettings(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="panel settings-panel">
        <h2 className="panel-title">Settings</h2>
        {error ? (
          <div className="status status-error">{error}</div>
        ) : (
          <div className="muted small">Loading…</div>
        )}
      </div>
    );
  }

  return (
    <div className="panel settings-panel">
      <h2 className="panel-title">Default settings</h2>

      {error && <div className="status status-error">{error}</div>}

      <label className="field">
        <span>
          Density <span className="muted">({settings.density})</span>
        </span>
        <input
          type="range"
          min={0}
          max={15}
          step={1}
          value={settings.density}
          onChange={(e) => patch({ density: clamp(Number(e.target.value), 0, 15) })}
        />
      </label>

      <label className="field">
        <span>Gap (mm)</span>
        <input
          type="number"
          min={0}
          max={25}
          step={0.5}
          value={settings.gapMm}
          onChange={(e) =>
            patch({
              gapMm: Math.min(25, Math.max(0, Number(e.target.value) || 0)),
            })
          }
        />
      </label>

      <label className="field">
        <span>Default dither</span>
        <select
          value={settings.dither}
          onChange={(e) => patch({ dither: e.target.value as DitherMode })}
        >
          <option value="threshold">Threshold (line art / text)</option>
          <option value="floyd-steinberg">Floyd–Steinberg (photos)</option>
          <option value="none">None</option>
        </select>
      </label>

      {settings.dither === 'threshold' && (
        <label className="field">
          <span>
            Threshold <span className="muted">({settings.threshold})</span>
          </span>
          <input
            type="range"
            min={0}
            max={255}
            step={1}
            value={settings.threshold}
            onChange={(e) =>
              patch({ threshold: clamp(Number(e.target.value), 0, 255) })
            }
          />
        </label>
      )}

      <div className="settings-foot">
        <button className="btn" disabled={saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save defaults'}
        </button>
        {savedAt && <span className="muted small">Saved</span>}
      </div>
    </div>
  );
}
