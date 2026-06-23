import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Stage, Layer, Rect, Image as KonvaImage, Transformer, Line } from 'react-konva';
import Konva from 'konva';
import type { Preset } from '../../shared/presets';

/**
 * The single source of truth for the image placement is kept in PRINT-DOT space:
 * a coordinate system whose canvas is exactly preset.widthPx x preset.heightPx.
 * On screen we draw the same scene multiplied by `viewScale`; offscreen (export)
 * we draw it at viewScale = 1, so screen positions map 1:1 to print dots.
 */
export type ImageTransform = {
  x: number; // top-left x in dot space (before rotation, Konva node x)
  y: number; // top-left y in dot space
  scaleX: number; // dots per natural pixel
  scaleY: number;
  rotation: number; // degrees
};

export type ExportResult = {
  pngBase64: string;
  widthPx: number;
  heightPx: number;
};

export type EditorHandle = {
  exportPrintPng: () => ExportResult | null;
  scaleToFit: () => void;
  center: () => void;
  removeImage: () => void;
  hasImage: () => boolean;
  /** Load an image from a (same-origin) URL into the editor. */
  loadImageFromUrl: (url: string) => Promise<void>;
  /** Current placement in DOT space, or null when no image is loaded. */
  getTransform: () => ImageTransform | null;
  /** Replace the placement (DOT space). No-op if no image yet. */
  setTransform: (t: ImageTransform) => void;
};

type Props = {
  preset: Preset;
  onImageLoadedChange?: (loaded: boolean) => void;
  /** If provided, the "Upload image" file is handed to the parent (to persist as
   *  an asset and load via loadImageFromUrl) instead of being loaded locally.
   *  This is what gives an uploaded image an assetId so templates can save it. */
  onUploadFile?: (file: File) => void;
};

// Max on-screen pixels the artboard view may occupy.
const MAX_VIEW_W = 560;
const MAX_VIEW_H = 640;

// Snapping in SCREEN px (adapted from the official Konva "Objects Snapping" demo).
const SNAP_PX = 6;
const GUIDE_COLOR = 'rgb(0,161,255)';

type GuideStop = number;

// Konva's transformer box shape (Konva.Box isn't exported from the typings).
type TransformBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { preset, onImageLoadedChange, onUploadFile },
  ref
) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [transform, setTransform] = useState<ImageTransform | null>(null);
  const [selected, setSelected] = useState(false);
  // Dashed snapping guides (screen px), rendered in an overlay layer.
  const [vLines, setVLines] = useState<number[]>([]);
  const [hLines, setHLines] = useState<number[]>([]);

  const stageRef = useRef<Konva.Stage | null>(null);
  const imageNodeRef = useRef<Konva.Image | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Compute the on-screen scale so the artboard fits the available box while
  // preserving the preset's exact aspect ratio.
  const viewScale = Math.min(
    MAX_VIEW_W / preset.widthPx,
    MAX_VIEW_H / preset.heightPx
  );
  const viewW = Math.round(preset.widthPx * viewScale);
  const viewH = Math.round(preset.heightPx * viewScale);

  // Artboard snap stops in SCREEN px: each edge + center along each axis.
  const vStops: GuideStop[] = [0, viewW / 2, viewW];
  const hStops: GuideStop[] = [0, viewH / 2, viewH];

  // Compute a transform that centers + fits the image inside the dot-space canvas.
  const computeFitTransform = useCallback(
    (image: HTMLImageElement): ImageTransform => {
      const iw = image.naturalWidth || image.width;
      const ih = image.naturalHeight || image.height;
      if (!iw || !ih) {
        return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
      }
      const s = Math.min(preset.widthPx / iw, preset.heightPx / ih);
      const w = iw * s;
      const h = ih * s;
      return {
        x: (preset.widthPx - w) / 2,
        y: (preset.heightPx - h) / 2,
        scaleX: s,
        scaleY: s,
        rotation: 0,
      };
    },
    [preset.widthPx, preset.heightPx]
  );

  const computeCenterTransform = useCallback(
    (image: HTMLImageElement, t: ImageTransform): ImageTransform => {
      const iw = image.naturalWidth || image.width;
      const ih = image.naturalHeight || image.height;
      // Center using the unrotated bounding box of the scaled image.
      const w = iw * t.scaleX;
      const h = ih * t.scaleY;
      return {
        ...t,
        x: (preset.widthPx - w) / 2,
        y: (preset.heightPx - h) / 2,
      };
    },
    [preset.widthPx, preset.heightPx]
  );

  // Notify parent when image presence changes.
  useEffect(() => {
    onImageLoadedChange?.(!!img);
  }, [img, onImageLoadedChange]);

  // When the preset changes and we have an image, re-fit so it stays sensible.
  useEffect(() => {
    if (img) {
      setTransform(computeFitTransform(img));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.id]);

  // Attach the transformer to the image node when selected.
  useLayoutEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    if (selected && img && imageNodeRef.current) {
      tr.nodes([imageNodeRef.current]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selected, img, transform, viewScale]);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new window.Image();
      image.onload = () => {
        setImg(image);
        setTransform(computeFitTransform(image));
        setSelected(true);
      };
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    // Prefer the parent (persist as asset -> load via URL); else load locally.
    if (onUploadFile) onUploadFile(file);
    else handleFile(file);
  };

  // Persist the on-screen node transform back into dot space.
  const commitNodeTransform = () => {
    const node = imageNodeRef.current;
    if (!node) return;
    setTransform({
      x: node.x() / viewScale,
      y: node.y() / viewScale,
      scaleX: node.scaleX() / viewScale,
      scaleY: node.scaleY() / viewScale,
      rotation: node.rotation(),
    });
  };

  // ----- Snapping helpers (screen px) -----------------------------------------
  const clearGuides = () => {
    setVLines([]);
    setHLines([]);
  };

  // Find the nearest artboard stop for a set of candidate edges; returns the
  // {stop, offset, diff} of the best snap within SNAP_PX, else null.
  const nearestSnap = (
    candidates: number[],
    stops: GuideStop[]
  ): { stop: number; offset: number } | null => {
    let best: { stop: number; offset: number; diff: number } | null = null;
    for (const c of candidates) {
      for (const s of stops) {
        const diff = Math.abs(c - s);
        if (diff <= SNAP_PX && (!best || diff < best.diff)) {
          best = { stop: s, offset: s - c, diff };
        }
      }
    }
    return best ? { stop: best.stop, offset: best.offset } : null;
  };

  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const box = node.getClientRect({ relativeTo: node.getStage() ?? undefined });
    // Candidate vertical-line positions (x): left, center, right.
    const vCandidates = [box.x, box.x + box.width / 2, box.x + box.width];
    // Candidate horizontal-line positions (y): top, middle, bottom.
    const hCandidates = [box.y, box.y + box.height / 2, box.y + box.height];

    const vSnap = nearestSnap(vCandidates, vStops);
    const hSnap = nearestSnap(hCandidates, hStops);

    const abs = node.absolutePosition();
    let nextX = abs.x;
    let nextY = abs.y;
    const nextV: number[] = [];
    const nextH: number[] = [];

    if (vSnap) {
      nextX = abs.x + vSnap.offset;
      nextV.push(vSnap.stop);
    }
    if (hSnap) {
      nextY = abs.y + hSnap.offset;
      nextH.push(hSnap.stop);
    }

    if (vSnap || hSnap) {
      node.absolutePosition({ x: nextX, y: nextY });
    }
    setVLines(nextV);
    setHLines(nextH);
  };

  const onDragEnd = () => {
    clearGuides();
    commitNodeTransform();
  };

  // ----- Imperative API exposed to the parent (App) -----
  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      hasImage: () => !!img,
      getTransform: () => (transform ? { ...transform } : null),
      setTransform: (t: ImageTransform) => {
        setTransform({ ...t });
      },
      loadImageFromUrl: (url: string) =>
        new Promise<void>((resolve, reject) => {
          const image = new window.Image();
          image.onload = () => {
            setImg(image);
            setTransform(computeFitTransform(image));
            setSelected(true);
            resolve();
          };
          image.onerror = () => reject(new Error('Failed to load image.'));
          // Same-origin /api endpoint, so no crossOrigin needed.
          image.src = url;
        }),
      removeImage: () => {
        setImg(null);
        setTransform(null);
        setSelected(false);
        clearGuides();
      },
      scaleToFit: () => {
        if (img) {
          setTransform(computeFitTransform(img));
          setSelected(true);
        }
      },
      center: () => {
        if (img && transform) {
          setTransform(computeCenterTransform(img, transform));
        }
      },
      exportPrintPng: (): ExportResult | null => {
        if (!img || !transform) return null;

        // Build an offscreen stage at EXACTLY the print-dot dimensions.
        const container = document.createElement('div');
        const stage = new Konva.Stage({
          container,
          width: preset.widthPx,
          height: preset.heightPx,
        });
        const layer = new Konva.Layer();
        stage.add(layer);

        // White label background.
        layer.add(
          new Konva.Rect({
            x: 0,
            y: 0,
            width: preset.widthPx,
            height: preset.heightPx,
            fill: '#ffffff',
          })
        );

        // Image drawn with the dot-space transform (viewScale = 1) → 1:1 dots.
        const node = new Konva.Image({
          image: img,
          x: transform.x,
          y: transform.y,
          scaleX: transform.scaleX,
          scaleY: transform.scaleY,
          rotation: transform.rotation,
        });
        // Clip overflow to the label bounds.
        layer.clip({ x: 0, y: 0, width: preset.widthPx, height: preset.heightPx });
        layer.add(node);
        layer.draw();

        const dataUrl = stage.toDataURL({
          mimeType: 'image/png',
          pixelRatio: 1,
        });

        stage.destroy();

        return {
          pngBase64: dataUrl,
          widthPx: preset.widthPx,
          heightPx: preset.heightPx,
        };
      },
    }),
    [
      img,
      transform,
      preset.widthPx,
      preset.heightPx,
      computeFitTransform,
      computeCenterTransform,
    ]
  );

  // Deselect when clicking empty stage area.
  const onStageMouseDown = (
    e: Konva.KonvaEventObject<MouseEvent | TouchEvent>
  ) => {
    if (e.target === e.target.getStage()) {
      setSelected(false);
      return;
    }
    // Clicking the background rect (not the image) also deselects.
    if (e.target.name() === 'bg') {
      setSelected(false);
    }
  };

  // Best-effort transformer snapping: snap the resize box edges/center to the
  // same artboard stops. Never throws (falls back to newBox on any issue).
  const boundBoxFunc = (
    oldBox: TransformBox,
    newBox: TransformBox
  ): TransformBox => {
    try {
      if (newBox.width < 5 || newBox.height < 5) return oldBox;

      // Konva boundBox is given in absolute (stage) coords for an unrotated box;
      // when rotated we skip edge snapping to avoid mangling the box.
      if (Math.abs(newBox.rotation || 0) > 0.001) return newBox;

      const box = { ...newBox };

      // Snap left/right edges (x axis).
      const vLeft = nearestSnap([box.x], vStops);
      if (vLeft) {
        box.width += box.x - vLeft.stop;
        box.x = vLeft.stop;
      } else {
        const vRight = nearestSnap([box.x + box.width], vStops);
        if (vRight) box.width = vRight.stop - box.x;
      }

      // Snap top/bottom edges (y axis).
      const hTop = nearestSnap([box.y], hStops);
      if (hTop) {
        box.height += box.y - hTop.stop;
        box.y = hTop.stop;
      } else {
        const hBottom = nearestSnap([box.y + box.height], hStops);
        if (hBottom) box.height = hBottom.stop - box.y;
      }

      if (box.width < 5 || box.height < 5) return newBox;
      return box;
    } catch {
      return newBox;
    }
  };

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFileChange}
          style={{ display: 'none' }}
        />
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          {img ? 'Replace image' : 'Upload image'}
        </button>
      </div>

      <div className="artboard-wrap">
        <Stage
          ref={stageRef}
          width={viewW}
          height={viewH}
          onMouseDown={onStageMouseDown}
          onTouchStart={onStageMouseDown}
          className="artboard-stage"
        >
          {/* Background / clip layer */}
          <Layer clipX={0} clipY={0} clipWidth={viewW} clipHeight={viewH}>
            <Rect
              name="bg"
              x={0}
              y={0}
              width={viewW}
              height={viewH}
              fill="#ffffff"
            />
            {img && transform && (
              <KonvaImage
                ref={imageNodeRef}
                name="snap-target"
                image={img}
                x={transform.x * viewScale}
                y={transform.y * viewScale}
                scaleX={transform.scaleX * viewScale}
                scaleY={transform.scaleY * viewScale}
                rotation={transform.rotation}
                draggable
                onClick={() => setSelected(true)}
                onTap={() => setSelected(true)}
                onDragMove={onDragMove}
                onDragEnd={onDragEnd}
                onTransformEnd={commitNodeTransform}
              />
            )}
          </Layer>

          {/* Transformer + snapping guides draw above the clip. */}
          <Layer>
            <Transformer
              ref={transformerRef}
              rotateEnabled
              keepRatio
              enabledAnchors={[
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
                'middle-left',
                'middle-right',
                'top-center',
                'bottom-center',
              ]}
              anchorSize={9}
              anchorCornerRadius={2}
              borderStroke="#2563eb"
              anchorStroke="#2563eb"
              boundBoxFunc={boundBoxFunc}
            />

            {vLines.map((x, i) => (
              <Line
                key={`v-${i}`}
                points={[x, 0, x, viewH]}
                stroke={GUIDE_COLOR}
                strokeWidth={1}
                dash={[4, 6]}
                listening={false}
              />
            ))}
            {hLines.map((y, i) => (
              <Line
                key={`h-${i}`}
                points={[0, y, viewW, y]}
                stroke={GUIDE_COLOR}
                strokeWidth={1}
                dash={[4, 6]}
                listening={false}
              />
            ))}
          </Layer>
        </Stage>
      </div>

      <div className="artboard-meta">
        {preset.widthMm} × {preset.heightMm} mm
        <span className="muted">
          {' '}
          · {preset.widthPx} × {preset.heightPx} dots
        </span>
      </div>
    </div>
  );
});

export default Editor;
