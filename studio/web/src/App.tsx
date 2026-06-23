import { useCallback, useEffect, useRef, useState } from 'react';
import { PRESETS as FALLBACK_PRESETS, type Preset } from '../../shared/presets';
import type {
  AssetMeta,
  CreateTemplateBody,
  Settings,
  Template,
} from '../../shared/types';
import { assetBytesUrl, getPresets, uploadAsset } from './api';
import Editor, { type EditorHandle } from './Editor';
import PrintPanel, { type PrintPanelHandle } from './PrintPanel';
import AssetLibrary from './AssetLibrary';
import TemplatePanel from './TemplatePanel';
import SettingsPanel from './SettingsPanel';

type Tab = 'assets' | 'templates' | 'settings';

export default function App() {
  const [presets, setPresets] = useState<Preset[]>(FALLBACK_PRESETS);
  const [activeId, setActiveId] = useState<string>(FALLBACK_PRESETS[0].id);
  const [hasImage, setHasImage] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  // The asset currently placed in the editor (for "Save as template").
  const [currentAssetId, setCurrentAssetId] = useState<string | null>(null);
  // Provenance of the last template loaded (sent to the server on print).
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('assets');
  const [templateRefresh, setTemplateRefresh] = useState(0);
  const [assetRefresh, setAssetRefresh] = useState(0);

  const editorRef = useRef<EditorHandle | null>(null);
  const printRef = useRef<PrintPanelHandle | null>(null);

  // Load presets from the API, fall back to the bundled shared module.
  useEffect(() => {
    let cancelled = false;
    getPresets()
      .then((list) => {
        if (cancelled || !Array.isArray(list) || list.length === 0) return;
        setPresets(list);
        setActiveId((prev) => (list.some((p) => p.id === prev) ? prev : list[0].id));
      })
      .catch(() => {
        /* keep fallback presets */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const active =
    presets.find((p) => p.id === activeId) ?? presets[0] ?? FALLBACK_PRESETS[0];

  const onImageLoadedChange = useCallback((loaded: boolean) => {
    setHasImage(loaded);
    if (!loaded) {
      setCurrentAssetId(null);
      setActiveTemplateId(null);
    }
  }, []);

  const exportPrintPng = useCallback(
    () => editorRef.current?.exportPrintPng() ?? null,
    []
  );

  const onSettings = useCallback((s: Settings) => setSettings(s), []);

  const selectPreset = (id: string) => {
    setActiveId(id);
    // Manual preset changes detach template provenance.
    setActiveTemplateId(null);
  };

  // AssetLibrary "Use": load into the editor and remember the asset id.
  const useAsset = useCallback(async (asset: AssetMeta) => {
    await editorRef.current?.loadImageFromUrl(assetBytesUrl(asset.id));
    setCurrentAssetId(asset.id);
    setActiveTemplateId(null);
  }, []);

  // Editor "Upload image": persist the file as an asset first (so it's reusable
  // AND has an assetId that templates can save), then load it into the editor.
  const uploadAndUse = useCallback(async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error('Could not read file.'));
        r.readAsDataURL(file);
      });
      const name = file.name.replace(/\.[^.]+$/, '') || file.name || 'image';
      const meta = await uploadAsset(name, dataUrl);
      await editorRef.current?.loadImageFromUrl(assetBytesUrl(meta.id));
      setCurrentAssetId(meta.id);
      setActiveTemplateId(null);
      setAssetRefresh((n) => n + 1); // show it in the Assets tab
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Upload failed.');
    }
  }, []);

  // Build the "Save as template" body from current preset + editor + settings.
  const buildSaveBody = useCallback(
    (name: string): CreateTemplateBody | null => {
      const t = editorRef.current?.getTransform() ?? null;
      const item =
        t && currentAssetId
          ? {
              assetId: currentAssetId,
              x: t.x,
              y: t.y,
              scaleX: t.scaleX,
              scaleY: t.scaleY,
              rotation: t.rotation,
            }
          : null;
      const body: CreateTemplateBody = {
        name,
        presetId: active.id,
        item,
      };
      if (settings) {
        body.settings = {
          density: settings.density,
          gapMm: settings.gapMm,
          dither: settings.dither,
          threshold: settings.threshold,
        };
      }
      return body;
    },
    [active.id, currentAssetId, settings]
  );

  // Load a template: set preset, load its asset, apply transform + settings.
  const loadTemplate = useCallback(
    async (t: Template) => {
      // Switch preset first so the editor canvas matches the saved DOT space.
      setActiveId(t.presetId);

      if (t.item) {
        await editorRef.current?.loadImageFromUrl(assetBytesUrl(t.item.assetId));
        editorRef.current?.setTransform({
          x: t.item.x,
          y: t.item.y,
          scaleX: t.item.scaleX,
          scaleY: t.item.scaleY,
          rotation: t.item.rotation,
        });
        setCurrentAssetId(t.item.assetId);
      } else {
        editorRef.current?.removeImage();
        setCurrentAssetId(null);
      }

      // Merge per-template overrides over the current global settings so the
      // PrintPanel prefill reflects what this template prints with.
      setSettings((prev) =>
        prev ? { ...prev, ...t.settings, updatedAt: prev.updatedAt } : prev
      );
      setActiveTemplateId(t.id);
    },
    []
  );

  const quickPrint = useCallback(
    async (t: Template) => {
      await loadTemplate(t);
      // Give React a tick to flush the editor image/transform before export.
      await new Promise((r) => setTimeout(r, 80));
      await printRef.current?.print();
    },
    [loadTemplate]
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">Label Studio</span>
        </div>
        <div className="brand-sub">Munbyn ITPP941 · 203 dpi</div>
      </header>

      <main className="app-main">
        <section className="left">
          <div className="presets panel">
            <div className="presets-title">Label size</div>
            <div className="preset-grid">
              {presets.map((p) => (
                <button
                  key={p.id}
                  className={'preset-btn' + (p.id === active.id ? ' active' : '')}
                  onClick={() => selectPreset(p.id)}
                >
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-dim">
                    {p.widthMm}×{p.heightMm} mm
                  </span>
                </button>
              ))}
            </div>
          </div>

          <Editor
            ref={editorRef}
            preset={active}
            onImageLoadedChange={onImageLoadedChange}
            onUploadFile={(f) => void uploadAndUse(f)}
          />

          <div className="img-actions">
            <button
              className="btn"
              disabled={!hasImage}
              onClick={() => editorRef.current?.scaleToFit()}
            >
              Scale to fit
            </button>
            <button
              className="btn"
              disabled={!hasImage}
              onClick={() => editorRef.current?.center()}
            >
              Center
            </button>
            <button
              className="btn btn-danger"
              disabled={!hasImage}
              onClick={() => editorRef.current?.removeImage()}
            >
              Remove image
            </button>
          </div>
        </section>

        <aside className="right">
          <div className="tabs">
            <button
              className={'tab' + (tab === 'assets' ? ' active' : '')}
              onClick={() => setTab('assets')}
            >
              Assets
            </button>
            <button
              className={'tab' + (tab === 'templates' ? ' active' : '')}
              onClick={() => setTab('templates')}
            >
              Templates
            </button>
            <button
              className={'tab' + (tab === 'settings' ? ' active' : '')}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
          </div>

          <div className="tab-body">
            {tab === 'assets' && (
              <AssetLibrary
                refreshKey={assetRefresh}
                onUse={(a) => {
                  void useAsset(a);
                  // Loading an asset may invalidate a template's asset; refresh.
                  setTemplateRefresh((n) => n + 1);
                }}
              />
            )}
            {tab === 'templates' && (
              <TemplatePanel
                buildSaveBody={buildSaveBody}
                onLoadTemplate={loadTemplate}
                onQuickPrint={quickPrint}
                refreshKey={templateRefresh}
              />
            )}
            {tab === 'settings' && <SettingsPanel onSettings={onSettings} />}
          </div>

          <PrintPanel
            ref={printRef}
            preset={active}
            hasImage={hasImage}
            exportPrintPng={exportPrintPng}
            settings={settings}
            templateId={activeTemplateId}
          />
        </aside>
      </main>
    </div>
  );
}
