import { useCallback, useEffect, useRef, useState } from "react";
import ArrowBackRoundedIcon from "@mui/icons-material/ArrowBackRounded";
import AutoFixOffRoundedIcon from "@mui/icons-material/AutoFixOffRounded";
import BrushRoundedIcon from "@mui/icons-material/BrushRounded";
import ColorLensRoundedIcon from "@mui/icons-material/ColorLensRounded";
import CropRoundedIcon from "@mui/icons-material/CropRounded";
import FlipRoundedIcon from "@mui/icons-material/FlipRounded";
import MoreHorizRoundedIcon from "@mui/icons-material/MoreHorizRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import RotateRightRoundedIcon from "@mui/icons-material/RotateRightRounded";
import type { Item } from "../App";
import { loadItemOverlay, saveItemOverlay, type OverlayPoint, type OverlayStroke, type OverlayTool } from "../lib/overlays";

type ViewerItem = Pick<Item, "id" | "title" | "filename"> & {
  previewUrl: string;
};

type ViewerCenterProps = {
  item: ViewerItem;
  imageIndex: number;
  imageCount: number;
  onBack: () => void;
};

type Point = {
  x: number;
  y: number;
};

type PanSession = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPan: Point;
};

type DrawSession = {
  pointerId: number;
};

type SaveIndicatorState = "idle" | "saving" | "saved" | "error";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const FIT_ZOOM = 1;
const DEFAULT_PEN_COLOR = "#ff7c5c";
const DEFAULT_PEN_WIDTH = 3;
const MIN_PEN_WIDTH = 1;
const MAX_PEN_WIDTH = 32;
const DEFAULT_ERASER_WIDTH = 18;
const MIN_ERASER_WIDTH = 6;
const MAX_ERASER_WIDTH = 60;
const SAVE_DEBOUNCE_MS = 500;
const PEN_COLOR_SWATCHES = [
  "#ff7c5c",
  "#fbbf24",
  "#22c55e",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
  "#ffffff",
  "#000000",
] as const;

const PLACEHOLDER_TOOLS = [
  { key: "crop", label: "Crop (coming soon)", icon: CropRoundedIcon },
  { key: "rotate", label: "Rotate (coming soon)", icon: RotateRightRoundedIcon },
  { key: "flip", label: "Flip (coming soon)", icon: FlipRoundedIcon },
  { key: "more", label: "More (coming soon)", icon: MoreHorizRoundedIcon },
] as const;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function cloneStrokes(strokes: OverlayStroke[]): OverlayStroke[] {
  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point })),
  }));
}

function strokePointToCanvas(point: OverlayPoint, width: number, height: number): Point {
  return {
    x: point.x * width,
    y: point.y * height,
  };
}

function renderStroke(ctx: CanvasRenderingContext2D, stroke: OverlayStroke, width: number, height: number) {
  if (stroke.points.length === 0) {
    return;
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.width;
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
    ctx.fillStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
  }

  if (stroke.points.length === 1) {
    const point = strokePointToCanvas(stroke.points[0], width, height);
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(1, stroke.width / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  const firstPoint = strokePointToCanvas(stroke.points[0], width, height);
  ctx.moveTo(firstPoint.x, firstPoint.y);
  for (let index = 1; index < stroke.points.length; index += 1) {
    const point = strokePointToCanvas(stroke.points[index], width, height);
    ctx.lineTo(point.x, point.y);
  }
  ctx.stroke();
  ctx.restore();
}

function ViewerCenter({ item, imageIndex, imageCount, onBack }: ViewerCenterProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const brushCursorRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [drawEnabled, setDrawEnabled] = useState(false);
  const [activeDrawTool, setActiveDrawTool] = useState<OverlayTool>("pen");
  const [penColor, setPenColor] = useState(DEFAULT_PEN_COLOR);
  const [penSize, setPenSize] = useState(DEFAULT_PEN_WIDTH);
  const [eraserSize, setEraserSize] = useState(DEFAULT_ERASER_WIDTH);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [overlayMarksVisible, setOverlayMarksVisible] = useState(true);
  const [saveIndicator, setSaveIndicator] = useState<SaveIndicatorState>("idle");
  const [showEraseAllConfirm, setShowEraseAllConfirm] = useState(false);

  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const panSessionRef = useRef<PanSession | null>(null);
  const drawSessionRef = useRef<DrawSession | null>(null);

  const strokesRef = useRef<OverlayStroke[]>([]);
  const draftStrokeRef = useRef<OverlayStroke | null>(null);
  const overlayRedrawRafRef = useRef<number | null>(null);
  const saveDebounceTimeoutRef = useRef<number | null>(null);
  const saveIndicatorTimeoutRef = useRef<number | null>(null);
  const overlayLoadedRef = useRef(false);
  const itemLoadVersionRef = useRef(0);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const clearSaveIndicatorTimeout = useCallback(() => {
    if (saveIndicatorTimeoutRef.current !== null) {
      window.clearTimeout(saveIndicatorTimeoutRef.current);
      saveIndicatorTimeoutRef.current = null;
    }
  }, []);

  const scheduleSavedIndicatorClear = useCallback(() => {
    clearSaveIndicatorTimeout();
    saveIndicatorTimeoutRef.current = window.setTimeout(() => {
      setSaveIndicator((current) => (current === "saved" ? "idle" : current));
      saveIndicatorTimeoutRef.current = null;
    }, 1400);
  }, [clearSaveIndicatorTimeout]);

  const ensureOverlayCanvasSize = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const imageEl = imageRef.current;
    if (!canvas || !imageEl) {
      return null;
    }

    const cssWidth = Math.max(1, Math.round(imageEl.clientWidth));
    const cssHeight = Math.max(1, Math.round(imageEl.clientHeight));
    if (cssWidth <= 0 || cssHeight <= 0) {
      return null;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const deviceWidth = Math.max(1, Math.round(cssWidth * dpr));
    const deviceHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }

    return { cssWidth, cssHeight, dpr };
  }, []);

  const hideBrushCursor = useCallback(() => {
    const cursor = brushCursorRef.current;
    if (!cursor) return;
    cursor.style.opacity = "0";
    cursor.style.transform = "translate3d(-9999px, -9999px, 0) translate(-50%, -50%)";
  }, []);

  const updateBrushCursor = useCallback(
    (clientX: number, clientY: number) => {
      if (!drawEnabled) {
        hideBrushCursor();
        return;
      }

      const canvas = overlayCanvasRef.current;
      const stage = stageRef.current;
      const cursor = brushCursorRef.current;
      if (!canvas || !stage || !cursor) {
        return;
      }

      const stageRect = stage.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        hideBrushCursor();
        return;
      }

      const isInsideCanvas =
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      if (!isInsideCanvas) {
        hideBrushCursor();
        return;
      }

      const brushSize = activeDrawTool === "eraser" ? eraserSize : penSize;
      const screenBrushSize = Math.max(2, brushSize * zoom);
      const x = clientX - stageRect.left;
      const y = clientY - stageRect.top;

      cursor.style.width = `${screenBrushSize}px`;
      cursor.style.height = `${screenBrushSize}px`;
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      cursor.style.opacity = "1";
    },
    [activeDrawTool, drawEnabled, eraserSize, hideBrushCursor, penSize, zoom],
  );

  const redrawOverlayNow = useCallback(() => {
    overlayRedrawRafRef.current = null;

    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return;
    }

    const metrics = ensureOverlayCanvasSize();
    if (!metrics) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    ctx.clearRect(0, 0, metrics.cssWidth, metrics.cssHeight);

    if (!overlayMarksVisible) {
      return;
    }

    const committedStrokes = strokesRef.current;
    for (let index = 0; index < committedStrokes.length; index += 1) {
      renderStroke(ctx, committedStrokes[index], metrics.cssWidth, metrics.cssHeight);
    }

    if (draftStrokeRef.current) {
      renderStroke(ctx, draftStrokeRef.current, metrics.cssWidth, metrics.cssHeight);
    }
  }, [ensureOverlayCanvasSize, overlayMarksVisible]);

  const requestOverlayRedraw = useCallback(() => {
    if (overlayRedrawRafRef.current !== null) {
      return;
    }
    overlayRedrawRafRef.current = window.requestAnimationFrame(redrawOverlayNow);
  }, [redrawOverlayNow]);

  const persistOverlay = useCallback(
    async (targetItemId: string) => {
      const snapshot = cloneStrokes(strokesRef.current);
      setSaveIndicator("saving");
      clearSaveIndicatorTimeout();
      try {
        await saveItemOverlay(targetItemId, snapshot);
        if (targetItemId === item.id) {
          setSaveIndicator("saved");
          scheduleSavedIndicatorClear();
        }
      } catch (error) {
        console.error("Failed to save item overlay:", targetItemId, error);
        if (targetItemId === item.id) {
          setSaveIndicator("error");
        }
      }
    },
    [clearSaveIndicatorTimeout, item.id, scheduleSavedIndicatorClear],
  );

  const scheduleOverlaySave = useCallback(() => {
    if (!overlayLoadedRef.current) {
      return;
    }

    if (saveDebounceTimeoutRef.current !== null) {
      window.clearTimeout(saveDebounceTimeoutRef.current);
    }

    setSaveIndicator("saving");
    clearSaveIndicatorTimeout();
    const itemId = item.id;
    saveDebounceTimeoutRef.current = window.setTimeout(() => {
      saveDebounceTimeoutRef.current = null;
      void persistOverlay(itemId);
    }, SAVE_DEBOUNCE_MS);
  }, [clearSaveIndicatorTimeout, item.id, persistOverlay]);

  const resetView = useCallback(() => {
    setZoom(FIT_ZOOM);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    panSessionRef.current = null;
  }, []);

  useEffect(() => {
    resetView();
  }, [item.id, resetView]);

  const applyZoom = useCallback((rawNextZoom: number, anchorClient?: Point) => {
    setZoom((currentZoom) => {
      const nextZoom = clamp(rawNextZoom, MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - currentZoom) < 0.0001) {
        return currentZoom;
      }

      setPan((currentPan) => {
        if (nextZoom <= FIT_ZOOM) {
          return { x: 0, y: 0 };
        }

        if (!anchorClient || !stageRef.current) {
          return currentPan;
        }

        const rect = stageRef.current.getBoundingClientRect();
        const cursor = {
          x: anchorClient.x - (rect.left + rect.width / 2),
          y: anchorClient.y - (rect.top + rect.height / 2),
        };
        const zoomRatio = nextZoom / currentZoom;

        return {
          x: cursor.x - zoomRatio * (cursor.x - currentPan.x),
          y: cursor.y - zoomRatio * (cursor.y - currentPan.y),
        };
      });

      return nextZoom;
    });
  }, []);

  const handleWheel: React.WheelEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * 0.0016);
    applyZoom(zoomRef.current * zoomFactor, { x: event.clientX, y: event.clientY });
  };

  const canPan = !drawEnabled && zoom > FIT_ZOOM + 0.001;

  const handleStagePointerDown: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (!canPan || event.button !== 0) {
      return;
    }

    panSessionRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: panRef.current,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleStagePointerMove: React.PointerEventHandler<HTMLDivElement> = (event) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - session.startClientX;
    const dy = event.clientY - session.startClientY;
    setPan({
      x: session.startPan.x + dx,
      y: session.startPan.y + dy,
    });
  };

  const endPan = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && panSessionRef.current?.pointerId !== pointerId) {
      return;
    }
    panSessionRef.current = null;
    setIsPanning(false);
  }, []);

  const readNormalizedPoint = useCallback((clientX: number, clientY: number): OverlayPoint | null => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1),
    };
  }, []);

  const finishDrawing = useCallback(
    (pointerId?: number) => {
      if (pointerId !== undefined && drawSessionRef.current?.pointerId !== pointerId) {
        return;
      }

      if (draftStrokeRef.current && draftStrokeRef.current.points.length > 0) {
        strokesRef.current = [...strokesRef.current, draftStrokeRef.current];
        setStrokeCount(strokesRef.current.length);
        scheduleOverlaySave();
      }
      draftStrokeRef.current = null;
      drawSessionRef.current = null;
      setIsDrawing(false);
      requestOverlayRedraw();
    },
    [requestOverlayRedraw, scheduleOverlaySave],
  );

  const handleOverlayPointerDown: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    if (!drawEnabled || event.button !== 0) {
      return;
    }

    const firstPoint = readNormalizedPoint(event.clientX, event.clientY);
    if (!firstPoint) {
      return;
    }

    drawSessionRef.current = {
      pointerId: event.pointerId,
    };
    draftStrokeRef.current = {
      tool: activeDrawTool,
      color: activeDrawTool === "eraser" ? DEFAULT_PEN_COLOR : penColor,
      width: activeDrawTool === "eraser" ? eraserSize : penSize,
      points: [firstPoint],
    };
    setIsDrawing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    updateBrushCursor(event.clientX, event.clientY);
    requestOverlayRedraw();
    event.preventDefault();
    event.stopPropagation();
  };

  const handleOverlayPointerMove: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    if (drawEnabled) {
      updateBrushCursor(event.clientX, event.clientY);
    }

    const session = drawSessionRef.current;
    const draftStroke = draftStrokeRef.current;
    if (!session || session.pointerId !== event.pointerId || !draftStroke) {
      return;
    }

    const point = readNormalizedPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }

    const lastPoint = draftStroke.points[draftStroke.points.length - 1];
    if (lastPoint) {
      const dx = point.x - lastPoint.x;
      const dy = point.y - lastPoint.y;
      if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) {
        return;
      }
    }

    draftStroke.points.push(point);
    requestOverlayRedraw();
    event.preventDefault();
    event.stopPropagation();
  };

  const togglePenDraw = useCallback(() => {
    setActiveDrawTool("pen");
    setDrawEnabled((current) => !(current && activeDrawTool === "pen"));
  }, [activeDrawTool]);

  const toggleEraserDraw = useCallback(() => {
    setActiveDrawTool("eraser");
    setDrawEnabled((current) => !(current && activeDrawTool === "eraser"));
  }, [activeDrawTool]);

  const undoLastStroke = useCallback(() => {
    if (draftStrokeRef.current) {
      draftStrokeRef.current = null;
      drawSessionRef.current = null;
      setIsDrawing(false);
      requestOverlayRedraw();
      return true;
    }

    if (strokesRef.current.length === 0) {
      return false;
    }

    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    requestOverlayRedraw();
    scheduleOverlaySave();
    return true;
  }, [requestOverlayRedraw, scheduleOverlaySave]);

  useEffect(() => {
    let cancelled = false;
    const loadVersion = itemLoadVersionRef.current + 1;
    itemLoadVersionRef.current = loadVersion;

    overlayLoadedRef.current = false;
    if (saveDebounceTimeoutRef.current !== null) {
      window.clearTimeout(saveDebounceTimeoutRef.current);
      saveDebounceTimeoutRef.current = null;
    }
    clearSaveIndicatorTimeout();
    setSaveIndicator("idle");
    strokesRef.current = [];
    setStrokeCount(0);
    draftStrokeRef.current = null;
    drawSessionRef.current = null;
    setIsDrawing(false);
    setShowEraseAllConfirm(false);
    requestOverlayRedraw();

    void loadItemOverlay(item.id)
      .then((loadedStrokes) => {
        if (cancelled || itemLoadVersionRef.current !== loadVersion) {
          return;
        }
        strokesRef.current = loadedStrokes;
        setStrokeCount(loadedStrokes.length);
        overlayLoadedRef.current = true;
        requestOverlayRedraw();
      })
      .catch((error) => {
        if (cancelled || itemLoadVersionRef.current !== loadVersion) {
          return;
        }
        console.error("Failed to load item overlay:", item.id, error);
        overlayLoadedRef.current = true;
        setSaveIndicator("error");
        requestOverlayRedraw();
      });

    return () => {
      cancelled = true;
    };
  }, [clearSaveIndicatorTimeout, item.id, requestOverlayRedraw]);

  useEffect(() => {
    const itemId = item.id;
    return () => {
      if (draftStrokeRef.current && draftStrokeRef.current.points.length > 0) {
        strokesRef.current = [...strokesRef.current, draftStrokeRef.current];
        draftStrokeRef.current = null;
      }
      drawSessionRef.current = null;
      panSessionRef.current = null;
      hideBrushCursor();

      if (saveDebounceTimeoutRef.current !== null && overlayLoadedRef.current) {
        window.clearTimeout(saveDebounceTimeoutRef.current);
        saveDebounceTimeoutRef.current = null;
        void saveItemOverlay(itemId, cloneStrokes(strokesRef.current)).catch((error) => {
          console.error("Failed to flush item overlay save on viewer cleanup:", itemId, error);
        });
      }

      clearSaveIndicatorTimeout();
      if (overlayRedrawRafRef.current !== null) {
        window.cancelAnimationFrame(overlayRedrawRafRef.current);
        overlayRedrawRafRef.current = null;
      }
    };
  }, [clearSaveIndicatorTimeout, hideBrushCursor, item.id]);

  useEffect(() => {
    const imageEl = imageRef.current;
    if (!imageEl) {
      return;
    }

    const handleResize = () => {
      ensureOverlayCanvasSize();
      requestOverlayRedraw();
    };

    handleResize();

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(imageEl);
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [ensureOverlayCanvasSize, item.id, requestOverlayRedraw]);

  useEffect(() => {
    const handleUndoKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z") return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (isEditableKeyboardTarget(event.target)) return;
      if (!undoLastStroke()) return;
      event.preventDefault();
    };

    window.addEventListener("keydown", handleUndoKey);
    return () => window.removeEventListener("keydown", handleUndoKey);
  }, [undoLastStroke]);

  useEffect(() => {
    hideBrushCursor();
  }, [activeDrawTool, drawEnabled, eraserSize, hideBrushCursor, penSize]);

  useEffect(() => {
    requestOverlayRedraw();
  }, [overlayMarksVisible, requestOverlayRedraw]);

  const eraseAllStrokes = useCallback(() => {
    const hasAnyMarks = strokesRef.current.length > 0 || !!draftStrokeRef.current;
    if (!hasAnyMarks) {
      return;
    }
    setShowEraseAllConfirm(true);
  }, []);

  const confirmEraseAllStrokes = useCallback(() => {
    setShowEraseAllConfirm(false);

    draftStrokeRef.current = null;
    drawSessionRef.current = null;
    setIsDrawing(false);
    strokesRef.current = [];
    setStrokeCount(0);
    requestOverlayRedraw();
    scheduleOverlaySave();
  }, [requestOverlayRedraw, scheduleOverlaySave]);

  const zoomPercent = Math.round(zoom * 100);
  const isPenActive = drawEnabled && activeDrawTool === "pen";
  const isEraserActive = drawEnabled && activeDrawTool === "eraser";
  const hasAnyStrokes = strokeCount > 0 || isDrawing;
  const overlayVisibilityLabel = overlayMarksVisible ? "Hide" : "Show";
  const saveIndicatorLabel =
    saveIndicator === "saving"
      ? "Saving..."
      : saveIndicator === "saved"
        ? "Saved"
        : saveIndicator === "error"
          ? "Save failed"
          : "";

  return (
    <section className="image-viewer-shell" aria-label="Center image viewer">
      <header className="image-viewer-header">
        <div className="image-viewer-header-group image-viewer-header-left">
          <button
            type="button"
            className="image-viewer-back-button"
            onClick={onBack}
            aria-label="Back to grid"
          >
            <ArrowBackRoundedIcon fontSize="inherit" />
          </button>
          <div className="image-viewer-counter" aria-live="polite">
            {imageIndex + 1} / {imageCount}
          </div>
        </div>

        <div className="image-viewer-header-group image-viewer-header-center">
          <input
            className="image-viewer-zoom-slider"
            type="range"
            min={Math.round(MIN_ZOOM * 100)}
            max={Math.round(MAX_ZOOM * 100)}
            step={1}
            value={zoomPercent}
            aria-label="Zoom"
            onChange={(event) => {
              applyZoom(Number(event.currentTarget.value) / 100);
            }}
          />
          <div className="image-viewer-zoom-label">{zoomPercent}%</div>
        </div>

        <div className="image-viewer-header-group image-viewer-header-right" aria-label="Viewer tools">
          <div
            className={`image-viewer-save-indicator ${saveIndicator !== "idle" ? "is-visible" : ""} ${
              saveIndicator === "error" ? "is-error" : ""
            }`}
            aria-live="polite"
          >
            {saveIndicatorLabel}
          </div>
          <button
            type="button"
            className={`image-viewer-tool-button ${isPenActive ? "is-active" : ""}`}
            onClick={togglePenDraw}
            aria-pressed={isPenActive}
            title={drawEnabled ? "Pen tool" : "Enable drawing"}
          >
            <BrushRoundedIcon fontSize="inherit" />
          </button>
          <button
            type="button"
            className={`image-viewer-tool-button ${isEraserActive ? "is-active" : ""}`}
            onClick={toggleEraserDraw}
            aria-pressed={isEraserActive}
            title={drawEnabled ? "Eraser tool" : "Enable eraser"}
          >
            <AutoFixOffRoundedIcon fontSize="inherit" />
          </button>
          {PLACEHOLDER_TOOLS.slice(0, 3).map(({ key, label, icon: IconComponent }) => (
            <button
              key={key}
              type="button"
              className="image-viewer-tool-button is-placeholder"
              aria-disabled="true"
              title={label}
              onClick={(event) => {
                event.preventDefault();
              }}
            >
              <IconComponent fontSize="inherit" />
            </button>
          ))}
          <button
            type="button"
            className="image-viewer-tool-button"
            onClick={resetView}
            title="Reset view"
            aria-label="Reset view"
          >
            <RestartAltRoundedIcon fontSize="inherit" />
          </button>
          {PLACEHOLDER_TOOLS.slice(3).map(({ key, label, icon: IconComponent }) => (
            <button
              key={key}
              type="button"
              className="image-viewer-tool-button is-placeholder"
              aria-disabled="true"
              title={label}
              onClick={(event) => {
                event.preventDefault();
              }}
            >
              <IconComponent fontSize="inherit" />
            </button>
          ))}
        </div>
      </header>

      <div
        ref={stageRef}
        className={`image-viewer-stage ${canPan ? "can-pan" : ""} ${isPanning ? "is-panning" : ""} ${
          drawEnabled ? "draw-enabled" : ""
        } ${isDrawing ? "is-drawing" : ""}`}
        onWheel={handleWheel}
        onDoubleClick={resetView}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={(event) => endPan(event.pointerId)}
        onPointerCancel={(event) => endPan(event.pointerId)}
        onLostPointerCapture={(event) => endPan(event.pointerId)}
      >
        <div className="viewer-container">
          {isPenActive && (
            <div className="image-viewer-canvas-tools" aria-label="Pen color tools" onPointerEnter={hideBrushCursor}>
              <div className="image-viewer-color-swatch-list" role="group" aria-label="Pen color presets">
                {PEN_COLOR_SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`image-viewer-color-swatch ${
                      penColor.toLowerCase() === color.toLowerCase() ? "is-active" : ""
                    }`}
                    style={{ "--swatch-color": color } as React.CSSProperties}
                    aria-label={`Select pen color ${color}`}
                    aria-pressed={penColor.toLowerCase() === color.toLowerCase()}
                    title={`Pen color ${color}`}
                    onClick={() => {
                      setPenColor(color);
                    }}
                  />
                ))}
              </div>
              <div className="image-viewer-pen-size-group">
                <span className="image-viewer-pen-size-label">Brush</span>
                <input
                  className="image-viewer-pen-size-slider"
                  type="range"
                  min={MIN_PEN_WIDTH}
                  max={MAX_PEN_WIDTH}
                  step={1}
                  value={penSize}
                  aria-label="Brush size"
                  onChange={(event) => {
                    setPenSize(Number(event.currentTarget.value));
                  }}
                />
                <span className="image-viewer-pen-size-value">{Math.round(penSize)}px</span>
              </div>
              <label className="image-viewer-color-picker-button" title="Custom color">
                <span className="image-viewer-color-picker-icon" aria-hidden="true">
                  <ColorLensRoundedIcon fontSize="inherit" />
                </span>
                <span
                  className="image-viewer-color-picker-preview"
                  style={{ backgroundColor: penColor }}
                  aria-hidden="true"
                />
                <span className="image-viewer-color-picker-label">Custom</span>
                <input
                  className="image-viewer-color-picker-input"
                  type="color"
                  value={penColor}
                  aria-label="Custom pen color"
                  onChange={(event) => {
                    setPenColor(event.currentTarget.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="image-viewer-overlay-visibility-button"
                onClick={() => setOverlayMarksVisible((current) => !current)}
                title={overlayMarksVisible ? "Hide drawings" : "Show drawings"}
                aria-pressed={!overlayMarksVisible}
              >
                {overlayVisibilityLabel}
              </button>
            </div>
          )}
          {isEraserActive && (
            <div
              className="image-viewer-canvas-tools image-viewer-canvas-tools-eraser"
              aria-label="Eraser tools"
              onPointerEnter={hideBrushCursor}
            >
              <div className="image-viewer-eraser-size-group">
                <span className="image-viewer-eraser-size-label">Eraser</span>
                <input
                  className="image-viewer-eraser-size-slider"
                  type="range"
                  min={MIN_ERASER_WIDTH}
                  max={MAX_ERASER_WIDTH}
                  step={1}
                  value={eraserSize}
                  aria-label="Eraser size"
                  onChange={(event) => {
                    setEraserSize(Number(event.currentTarget.value));
                  }}
                />
                <span className="image-viewer-eraser-size-value">{Math.round(eraserSize)}px</span>
              </div>
              <button
                type="button"
                className="image-viewer-overlay-visibility-button"
                onClick={() => setOverlayMarksVisible((current) => !current)}
                title={overlayMarksVisible ? "Hide drawings" : "Show drawings"}
                aria-pressed={!overlayMarksVisible}
              >
                {overlayVisibilityLabel}
              </button>
              <button
                type="button"
                className="image-viewer-erase-all-button"
                onClick={eraseAllStrokes}
                disabled={!hasAnyStrokes}
                title={hasAnyStrokes ? "Erase all drawings" : "No drawings to erase"}
              >
                Erase all
              </button>
            </div>
          )}
          <div
            className="image-wrapper"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            }}
          >
            <img
              ref={imageRef}
              className="image-viewer-image"
              src={item.previewUrl}
              alt={item.title || item.filename || "Image"}
              draggable={false}
              onLoad={() => {
                ensureOverlayCanvasSize();
                requestOverlayRedraw();
              }}
            />
            <canvas
              ref={overlayCanvasRef}
              className={`image-viewer-overlay-canvas ${drawEnabled ? "draw-enabled" : ""}`}
              onPointerDown={handleOverlayPointerDown}
              onPointerMove={handleOverlayPointerMove}
              onPointerEnter={(event) => updateBrushCursor(event.clientX, event.clientY)}
              onPointerLeave={() => {
                if (!isDrawing) {
                  hideBrushCursor();
                }
              }}
              onPointerUp={(event) => finishDrawing(event.pointerId)}
              onPointerCancel={(event) => finishDrawing(event.pointerId)}
              onLostPointerCapture={(event) => {
                finishDrawing(event.pointerId);
                hideBrushCursor();
              }}
            />
          </div>
        </div>
        <div
          ref={brushCursorRef}
          className="image-viewer-brush-cursor"
          aria-hidden="true"
        />
      </div>
      {showEraseAllConfirm && hasAnyStrokes && (
        <div
          className="action-modal-backdrop"
          onClick={() => setShowEraseAllConfirm(false)}
          role="presentation"
        >
          <div
            className="action-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Erase all drawings confirmation"
          >
            <h3 className="action-modal-title">Erase all drawings?</h3>
            <p className="action-modal-body">
              This will remove all drawing and eraser strokes for this image.
            </p>
            <div className="action-modal-footer">
              <button
                type="button"
                className="action-modal-button"
                onClick={() => setShowEraseAllConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal-button danger"
                onClick={confirmEraseAllStrokes}
              >
                Erase all
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default ViewerCenter;
