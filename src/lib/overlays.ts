import { invoke } from "@tauri-apps/api/core";

export type OverlayPoint = {
  x: number;
  y: number;
};

export type OverlayTool = "pen" | "eraser";

export type OverlayStroke = {
  points: OverlayPoint[];
  width: number;
  color: string;
  tool: OverlayTool;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizePoint(raw: unknown): OverlayPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const point = raw as Partial<OverlayPoint>;
  if (typeof point.x !== "number" || typeof point.y !== "number") {
    return null;
  }
  return {
    x: clamp01(point.x),
    y: clamp01(point.y),
  };
}

function normalizeStroke(raw: unknown): OverlayStroke | null {
  if (!raw || typeof raw !== "object") return null;
  const stroke = raw as Partial<OverlayStroke>;
  if (!Array.isArray(stroke.points) || stroke.points.length === 0) {
    return null;
  }
  const points = stroke.points.map(normalizePoint).filter((point): point is OverlayPoint => point !== null);
  if (points.length === 0) {
    return null;
  }

  const tool: OverlayTool = stroke.tool === "eraser" ? "eraser" : "pen";
  const width =
    typeof stroke.width === "number" && Number.isFinite(stroke.width) && stroke.width > 0
      ? stroke.width
      : tool === "eraser"
        ? 18
        : 3;

  return {
    points,
    width,
    color: typeof stroke.color === "string" && stroke.color.trim().length > 0 ? stroke.color : "#ff7c5c",
    tool,
  };
}

export function normalizeOverlayStrokes(raw: unknown): OverlayStroke[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map(normalizeStroke).filter((stroke): stroke is OverlayStroke => stroke !== null);
}

export async function loadItemOverlay(itemId: string): Promise<OverlayStroke[]> {
  const result = await invoke<unknown>("load_item_overlay", { itemId });
  return normalizeOverlayStrokes(result);
}

export async function saveItemOverlay(itemId: string, strokes: OverlayStroke[]): Promise<number> {
  return invoke<number>("save_item_overlay", {
    itemId,
    strokes: normalizeOverlayStrokes(strokes),
  });
}
