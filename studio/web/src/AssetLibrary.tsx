import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetMeta } from '../../shared/types';
import {
  assetThumbUrl,
  deleteAsset,
  listAssets,
  uploadAsset,
} from './api';

type Props = {
  /** Called when the user clicks "Use" on a tile (App loads it into the editor). */
  onUse: (asset: AssetMeta) => void;
  /** Bumped by the parent to force a refresh after an external change. */
  refreshKey?: number;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export default function AssetLibrary({ onUse, refreshKey }: Props) {
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listAssets();
      setAssets(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const name = file.name.replace(/\.[^.]+$/, '') || file.name || 'asset';
      await uploadAsset(name, dataUrl);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    }
  };

  const onDelete = async (asset: AssetMeta) => {
    setError(null);
    setBusyId(asset.id);
    try {
      await deleteAsset(asset.id);
      await refresh();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setError(`"${asset.name}" is in use by a template.`);
      } else {
        setError(err instanceof Error ? err.message : 'Delete failed.');
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel asset-library">
      <div className="panel-head">
        <h2 className="panel-title">Assets</h2>
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
      </div>

      {error && <div className="status status-error">{error}</div>}

      {loading && assets.length === 0 ? (
        <div className="muted small">Loading…</div>
      ) : assets.length === 0 ? (
        <div className="muted small">No assets yet. Upload a PNG to start.</div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => (
            <div className="asset-tile" key={a.id}>
              <div className="asset-thumb">
                <img src={assetThumbUrl(a.id)} alt={a.name} loading="lazy" />
              </div>
              <div className="asset-name" title={a.name}>
                {a.name}
              </div>
              <div className="asset-dim muted">
                {a.width}×{a.height}
              </div>
              <div className="asset-actions">
                <button className="btn btn-sm" onClick={() => onUse(a)}>
                  Use
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={busyId === a.id}
                  onClick={() => onDelete(a)}
                >
                  {busyId === a.id ? '…' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
