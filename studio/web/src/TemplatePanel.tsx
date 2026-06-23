import { useCallback, useEffect, useState } from 'react';
import { getPreset } from '../../shared/presets';
import type { CreateTemplateBody, Template } from '../../shared/types';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
} from './api';

type Props = {
  /** Build the body for "Save as template" from current editor/app state. */
  buildSaveBody: (name: string) => CreateTemplateBody | null;
  /** Load a template into the editor (set preset, asset, transform, settings). */
  onLoadTemplate: (t: Template) => Promise<void> | void;
  /** Load the template, then run the print flow. */
  onQuickPrint: (t: Template) => Promise<void> | void;
  /** Bumped by parent to refresh after external changes. */
  refreshKey?: number;
};

function sizeLabel(presetId: string): string {
  const p = getPreset(presetId);
  return p ? `${p.widthMm}×${p.heightMm} mm` : presetId;
}

export default function TemplatePanel({
  buildSaveBody,
  onLoadTemplate,
  onQuickPrint,
  refreshKey,
}: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await listTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const onSave = async () => {
    const name = window.prompt('Template name?');
    if (!name || !name.trim()) return;
    const body = buildSaveBody(name.trim());
    if (!body) {
      setError('Nothing to save yet.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createTemplate(body);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const onLoad = async (t: Template) => {
    setError(null);
    setBusyId(t.id);
    try {
      await onLoadTemplate(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setBusyId(null);
    }
  };

  const onPrint = async (t: Template) => {
    setError(null);
    setBusyId(t.id);
    try {
      await onQuickPrint(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quick print failed.');
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (t: Template) => {
    setError(null);
    setBusyId(t.id);
    try {
      await deleteTemplate(t.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel template-panel">
      <div className="panel-head">
        <h2 className="panel-title">Templates</h2>
        <button className="btn btn-sm" disabled={saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save as template'}
        </button>
      </div>

      {error && <div className="status status-error">{error}</div>}

      {loading && templates.length === 0 ? (
        <div className="muted small">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="muted small">No templates saved yet.</div>
      ) : (
        <ul className="template-list">
          {templates.map((t) => (
            <li className="template-row" key={t.id}>
              <button
                className="template-main"
                disabled={busyId === t.id}
                onClick={() => onLoad(t)}
                title="Load template"
              >
                <span className="template-name">{t.name}</span>
                <span className="template-meta muted">
                  {sizeLabel(t.presetId)}
                  {t.item ? '' : ' · empty'}
                </span>
              </button>
              <div className="template-actions">
                <button
                  className="btn btn-sm"
                  disabled={busyId === t.id}
                  onClick={() => onPrint(t)}
                  title="Load and print"
                >
                  Quick print
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busyId === t.id}
                  onClick={() => onDelete(t)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
