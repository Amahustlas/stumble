import {
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";
import ContextMenu, { type ContextMenuAction } from "./components/ContextMenu";
import ItemGrid from "./components/ItemGrid";
import PreviewPanel from "./components/PreviewPanel";
import Sidebar from "./components/Sidebar";
import Topbar, { type TopbarFilterChip, type TopbarSortOption } from "./components/Topbar";
import {
  initDb,
  loadDbAppState,
  type Collection,
  type DbCollectionItemRecord,
  type DbInsertItemInput,
  type DbItemRecord,
  type Tag,
} from "./lib/db";
import {
  createCollection as createCollectionInDb,
  deleteCollection as deleteCollectionInDb,
  getAllCollections as getAllCollectionsInDb,
  updateCollectionName as updateCollectionNameInDb,
} from "./lib/repositories/collectionsRepo";
import {
  deleteItemsByIdsWithCleanup as deleteItemsByIdsWithCleanupInDb,
  finalizeItemImport as finalizeItemImportInDb,
  insertItem as insertItemInDb,
  insertItems as insertItemsInDb,
  markItemImportError as markItemImportErrorInDb,
  moveCollectionItemMemberships as moveCollectionItemMembershipsInDb,
  addItemsToCollection as addItemsToCollectionInDb,
  reorderCollectionItems as reorderCollectionItemsInDb,
  updateItemDescription as updateItemDescriptionInDb,
  updateItemPreferences as updateItemPreferencesInDb,
  updateItemTags as updateItemTagsInDb,
  updateItemBookmarkMetadata as updateItemBookmarkMetadataInDb,
  updateItemMediaState as updateItemMediaStateInDb,
} from "./lib/repositories/itemsRepo";
import {
  createTag as createTagInDb,
  deleteTag as deleteTagInDb,
  duplicateTag as duplicateTagInDb,
  reorderTags as reorderTagsInDb,
  updateTagColor as updateTagColorInDb,
  updateTagName as updateTagNameInDb,
} from "./lib/repositories/tagsRepo";
import { fetchBookmarkMetadata, type BookmarkMetadataFetchResult } from "./lib/bookmarks";
import {
  buildVaultKey,
  ensureStorageRoot,
  pickFiles,
  processImportBytesJob,
  processImportPathJob,
  type ImportPipelineResult,
} from "./lib/storage";
import {
  buildThumbnailPath,
  DedupeAsyncQueue,
  ensureThumbsRoot,
  fileExists,
  THUMB_CONCURRENCY,
  THUMB_MAX_SIZE,
  ThumbnailQueue,
} from "./lib/thumbs";
import {
  buildCollectionPathMap,
  buildCollectionTree,
  collectCollectionSubtreeIds,
  type CollectionTreeNode,
} from "./lib/collections";
import {
  createDefaultAdvancedItemFilters,
  filterItems,
  formatAdvancedItemFilterTypeLabel,
  hasActiveAdvancedItemFilters,
  normalizeAdvancedItemFilters,
  type AdvancedItemFilterType,
  type AdvancedItemFilters,
} from "./lib/itemFilters";

export type ItemType = "bookmark" | "image" | "video" | "pdf" | "file" | "note";
export type ThumbStatus = "ready" | "pending" | "skipped" | "error";
export type ImportStatus = "ready" | "processing" | "error";
export type BookmarkMetaStatus = "ready" | "pending" | "error";
export type ItemStatus = "saved" | "archived" | "processing" | "error";
type LibraryViewMode = "all" | "favorites";

export type ItemCollectionMembershipInstance = {
  instanceId: string;
  collectionId: string;
  customTitle?: string;
  customDescription?: string;
  sortIndex?: number;
  createdAt: number;
};

export type Item = {
  id: string;
  filename: string;
  type: ItemType;
  title: string;
  description: string;
  rating: number;
  isFavorite: boolean;
  status: ItemStatus;
  importStatus: ImportStatus;
  tagIds: string[];
  tags: string[];
  collectionId: string | null;
  collectionPath: string;
  collectionIds: string[];
  collectionInstancesByCollectionId: Record<string, ItemCollectionMembershipInstance>;
  createdAt: string;
  updatedAt: string;
  size: string;
  format: string;
  vaultKey?: string;
  vaultPath?: string;
  previewUrl?: string;
  thumbPath?: string;
  thumbUrl?: string;
  faviconPath?: string;
  faviconUrl?: string;
  hasThumb: boolean;
  thumbStatus: ThumbStatus;
  width?: number;
  height?: number;
  sizeBytes?: number;
  noteText?: string;
  sourceUrl?: string;
  hostname?: string;
  metaStatus: BookmarkMetaStatus;
};

const initialItems: Item[] = [];

type UndoableSnackbarActionKind = "move" | "duplicate" | "remove" | "delete";

type SnackbarState = {
  id: number;
  message: string;
  actionKind: UndoableSnackbarActionKind;
  visibleUntil: number;
  canUndo: boolean;
};

type PendingUndoableAction = {
  id: number;
  commit: () => Promise<void>;
  undoUi: () => void;
  finalizeUi?: () => void;
  timeoutId: number;
};

type SidebarItemDragPayload = {
  kind: "stumble-item-selection";
  itemIds: string[];
  sourceCollectionId: string | null;
  initiatedAt: number;
};

type PointerItemDragCandidate = {
  pointerId: number;
  itemIds: string[];
  sourceCollectionId: string | null;
  startX: number;
  startY: number;
};

type CustomItemDragState = {
  pointerId: number;
  itemIds: string[];
  sourceCollectionId: string | null;
  clientX: number;
  clientY: number;
  targetCollectionId: string | null;
  mode: "move" | "duplicate";
};

const SIDEBAR_ITEM_DRAG_MIME = "application/x-stumble-items";

function createCollectionMembershipInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ci-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneItemCollectionInstances(
  value: Record<string, ItemCollectionMembershipInstance>,
): Record<string, ItemCollectionMembershipInstance> {
  const next: Record<string, ItemCollectionMembershipInstance> = {};
  Object.entries(value).forEach(([collectionId, instance]) => {
    next[collectionId] = { ...instance };
  });
  return next;
}

function orderedCollectionIdsForItem(args: {
  currentIds: string[];
  nextInstancesByCollectionId: Record<string, ItemCollectionMembershipInstance>;
}): string[] {
  const { currentIds, nextInstancesByCollectionId } = args;
  const nextIdsSet = new Set(Object.keys(nextInstancesByCollectionId));
  const ordered = currentIds.filter((id) => nextIdsSet.has(id));
  Array.from(nextIdsSet)
    .filter((id) => !ordered.includes(id))
    .sort((a, b) => a.localeCompare(b))
    .forEach((id) => ordered.push(id));
  return ordered;
}

function withItemMembershipState(args: {
  item: Item;
  nextInstancesByCollectionId: Record<string, ItemCollectionMembershipInstance>;
  collectionPathById: Map<string, string>;
  preferredPrimaryCollectionId?: string | null;
  updatedAt?: string;
}): Item {
  const { item, nextInstancesByCollectionId, collectionPathById, updatedAt } = args;
  const collectionIds = orderedCollectionIdsForItem({
    currentIds: item.collectionIds,
    nextInstancesByCollectionId,
  });
  const preferredPrimaryCollectionId =
    args.preferredPrimaryCollectionId === undefined
      ? item.collectionId
      : args.preferredPrimaryCollectionId;
  const primaryCollectionId =
    preferredPrimaryCollectionId && nextInstancesByCollectionId[preferredPrimaryCollectionId]
      ? preferredPrimaryCollectionId
      : collectionIds[0] ?? null;

  return {
    ...item,
    collectionInstancesByCollectionId: nextInstancesByCollectionId,
    collectionIds,
    collectionId: primaryCollectionId,
    collectionPath:
      primaryCollectionId !== null
        ? collectionPathById.get(primaryCollectionId) ?? "All Items"
        : "All Items",
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function addCollectionMembershipToItem(args: {
  item: Item;
  collectionId: string;
  collectionPathById: Map<string, string>;
  instance?: Partial<ItemCollectionMembershipInstance>;
  preservePrimary?: boolean;
  updatedAt?: string;
}): Item {
  const { item, collectionId, collectionPathById, preservePrimary = true, updatedAt } = args;
  if (item.collectionInstancesByCollectionId[collectionId]) {
    return item;
  }
  const nextInstancesByCollectionId = cloneItemCollectionInstances(
    item.collectionInstancesByCollectionId,
  );
  nextInstancesByCollectionId[collectionId] = {
    instanceId: args.instance?.instanceId ?? createCollectionMembershipInstanceId(),
    collectionId,
    customTitle: args.instance?.customTitle,
    customDescription: args.instance?.customDescription,
    sortIndex: args.instance?.sortIndex ?? args.instance?.createdAt ?? Date.now(),
    createdAt: args.instance?.createdAt ?? Date.now(),
  };
  return withItemMembershipState({
    item,
    nextInstancesByCollectionId,
    collectionPathById,
    preferredPrimaryCollectionId: preservePrimary ? item.collectionId : collectionId,
    updatedAt,
  });
}

function removeCollectionMembershipFromItem(args: {
  item: Item;
  collectionId: string;
  collectionPathById: Map<string, string>;
  updatedAt?: string;
}): Item {
  const { item, collectionId, collectionPathById, updatedAt } = args;
  if (!item.collectionInstancesByCollectionId[collectionId]) {
    return item;
  }
  const nextInstancesByCollectionId = cloneItemCollectionInstances(
    item.collectionInstancesByCollectionId,
  );
  delete nextInstancesByCollectionId[collectionId];
  return withItemMembershipState({
    item,
    nextInstancesByCollectionId,
    collectionPathById,
    preferredPrimaryCollectionId: item.collectionId === collectionId ? null : item.collectionId,
    updatedAt,
  });
}

function moveCollectionMembershipOnItem(args: {
  item: Item;
  sourceCollectionId: string | null;
  targetCollectionId: string | null;
  collectionPathById: Map<string, string>;
  updatedAt?: string;
}): Item {
  const { item, sourceCollectionId, targetCollectionId, collectionPathById, updatedAt } = args;
  if (sourceCollectionId === targetCollectionId) {
    return item;
  }

  if (sourceCollectionId === null) {
    if (targetCollectionId === null) return item;
    return addCollectionMembershipToItem({
      item,
      collectionId: targetCollectionId,
      collectionPathById,
      preservePrimary: false,
      updatedAt,
    });
  }

  if (!item.collectionInstancesByCollectionId[sourceCollectionId]) {
    return item;
  }

  if (targetCollectionId === null) {
    return removeCollectionMembershipFromItem({
      item,
      collectionId: sourceCollectionId,
      collectionPathById,
      updatedAt,
    });
  }

  if (item.collectionInstancesByCollectionId[targetCollectionId]) {
    return removeCollectionMembershipFromItem({
      item,
      collectionId: sourceCollectionId,
      collectionPathById,
      updatedAt,
    });
  }

  const nextInstancesByCollectionId = cloneItemCollectionInstances(
    item.collectionInstancesByCollectionId,
  );
  const sourceInstance = nextInstancesByCollectionId[sourceCollectionId];
  delete nextInstancesByCollectionId[sourceCollectionId];
  nextInstancesByCollectionId[targetCollectionId] = {
    ...sourceInstance,
    collectionId: targetCollectionId,
  };
  return withItemMembershipState({
    item,
    nextInstancesByCollectionId,
    collectionPathById,
    preferredPrimaryCollectionId: targetCollectionId,
    updatedAt,
  });
}

type ItemMembershipUiSnapshot = Pick<
  Item,
  "id" | "collectionId" | "collectionPath" | "collectionIds" | "collectionInstancesByCollectionId" | "updatedAt"
>;

function createItemMembershipSnapshot(item: Item): ItemMembershipUiSnapshot {
  return {
    id: item.id,
    collectionId: item.collectionId,
    collectionPath: item.collectionPath,
    collectionIds: [...item.collectionIds],
    collectionInstancesByCollectionId: cloneItemCollectionInstances(
      item.collectionInstancesByCollectionId,
    ),
    updatedAt: item.updatedAt,
  };
}

function restoreItemMembershipSnapshot(item: Item, snapshot: ItemMembershipUiSnapshot): Item {
  return {
    ...item,
    collectionId: snapshot.collectionId,
    collectionPath: snapshot.collectionPath,
    collectionIds: [...snapshot.collectionIds],
    collectionInstancesByCollectionId: cloneItemCollectionInstances(
      snapshot.collectionInstancesByCollectionId,
    ),
    updatedAt: snapshot.updatedAt,
  };
}

function parseSidebarItemDragPayload(dataTransfer: DataTransfer): SidebarItemDragPayload | null {
  const raw =
    dataTransfer.getData(SIDEBAR_ITEM_DRAG_MIME) ||
    dataTransfer.getData("application/x-stumble-item-selection") ||
    dataTransfer.getData("text/plain");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarItemDragPayload>;
    if (parsed.kind !== "stumble-item-selection") return null;
    if (!Array.isArray(parsed.itemIds)) return null;
    const itemIds = parsed.itemIds.filter((value): value is string => typeof value === "string");
    if (itemIds.length === 0) return null;
    const sourceCollectionId =
      typeof parsed.sourceCollectionId === "string" ? parsed.sourceCollectionId : null;
    return {
      kind: "stumble-item-selection",
      itemIds,
      sourceCollectionId,
      initiatedAt:
        typeof parsed.initiatedAt === "number" && Number.isFinite(parsed.initiatedAt)
          ? parsed.initiatedAt
          : Date.now(),
    };
  } catch {
    return null;
  }
}

function collectionDropTargetIdFromPoint(clientX: number, clientY: number): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  // Primary: geometry-based hit test (more reliable in WebView drag scenarios than event.target/elementsFromPoint).
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>("[data-collection-drop-id]"),
  );
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const withinX = clientX >= rect.left && clientX <= rect.right;
    const withinY = clientY >= rect.top && clientY <= rect.bottom;
    if (withinX && withinY) {
      const collectionId = row.dataset.collectionDropId;
      if (collectionId && collectionId.trim().length > 0) {
        return collectionId;
      }
    }
  }

  // Secondary: DOM stack lookup when available.
  if (typeof document.elementsFromPoint === "function") {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const element of stack) {
      if (!(element instanceof HTMLElement)) continue;
      const row = element.closest<HTMLElement>("[data-collection-drop-id]");
      const collectionId = row?.dataset.collectionDropId;
      if (collectionId && collectionId.trim().length > 0) {
        return collectionId;
      }
    }
  }
  return null;
}

type GridReorderDropTarget = {
  itemId: string;
  position: "before" | "after";
};

function itemGridReorderTargetFromPoint(
  clientX: number,
  clientY: number,
  draggedItemId: string,
): GridReorderDropTarget | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cards = Array.from(document.querySelectorAll<HTMLElement>(".item-grid .item-card[data-item-id]"));
  for (const card of cards) {
    const targetItemId = card.dataset.itemId;
    if (!targetItemId || targetItemId === draggedItemId) {
      continue;
    }
    const rect = card.getBoundingClientRect();
    const withinX = clientX >= rect.left && clientX <= rect.right;
    const withinY = clientY >= rect.top && clientY <= rect.bottom;
    if (!withinX || !withinY) {
      continue;
    }

    const xRatio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    const yRatio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const rowTolerancePx = 6;
    const sameRowCount = cards.reduce((count, candidate) => {
      const candidateRect = candidate.getBoundingClientRect();
      return Math.abs(candidateRect.top - rect.top) <= rowTolerancePx ? count + 1 : count;
    }, 0);
    const isMultiColumnRow = sameRowCount > 1;

    // Bias toward "before" so dragging onto the first item can reliably place at index 0.
    let position: "before" | "after";
    if (isMultiColumnRow) {
      if (yRatio <= 0.22) {
        position = "before";
      } else if (yRatio >= 0.78) {
        position = "after";
      } else {
        position = xRatio >= 0.68 ? "after" : "before";
      }
    } else {
      position = yRatio >= 0.68 ? "after" : "before";
    }
    return { itemId: targetItemId, position };
  }
  return null;
}

function isPointInsideItemGridArea(clientX: number, clientY: number): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const gridWrap = document.querySelector<HTMLElement>(".item-grid-wrap");
  if (!gridWrap) {
    return false;
  }
  const rect = gridWrap.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi)$/i;
const THUMB_SKIP_MAX_DIMENSION = 640;
const THUMB_JOB_TIMEOUT_MS = 60_000;
const THUMB_JOB_MAX_RETRIES = 1;
const THUMB_QUEUE_START_DELAY_MS = 700;
const USER_INTERACTION_IDLE_MS = 600;
const IMPORT_QUEUE_CONCURRENCY = 1;
const BOOKMARK_META_QUEUE_CONCURRENCY = 2;
const BOOKMARK_META_JOB_TIMEOUT_MS = 12_000;
const BOOKMARK_META_JOB_MAX_RETRIES = 1;
const UNDO_SNACKBAR_TIMEOUT_MS = 7_000;
const LEFT_PANEL_WIDTH_MIN = 220;
const LEFT_PANEL_WIDTH_MAX = 420;
const RIGHT_PANEL_WIDTH_MIN = 280;
const RIGHT_PANEL_WIDTH_MAX = 520;
const DEFAULT_LEFT_PANEL_WIDTH = 260;
const DEFAULT_RIGHT_PANEL_WIDTH = 320;
const LEFT_PANEL_WIDTH_STORAGE_KEY = "stumble:left-panel-width";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "stumble:right-panel-width";
const LIST_VIEW_CONTROLS_STORAGE_KEY = "stumble:list-view-controls";
const DEFAULT_COLLECTION_ICON = "folder";
const DEFAULT_COLLECTION_COLOR = "#8B8B8B";
const DEFAULT_COLLECTION_NAME = "New Collection";
const DEFAULT_TAG_COLOR = "#64748b";
const DEFAULT_TAG_NAME = "New tag";
const TAG_COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#a855f7",
] as const;

type PersistedListViewControls = {
  searchQuery: string;
  sortOption: TopbarSortOption;
  advancedFilters: AdvancedItemFilters;
};

function nextCollectionName(collections: Collection[]): string {
  const normalizedNames = new Set(
    collections.map((collection) => collection.name.trim().toLowerCase()),
  );
  if (!normalizedNames.has(DEFAULT_COLLECTION_NAME.toLowerCase())) {
    return DEFAULT_COLLECTION_NAME;
  }

  let suffix = 2;
  while (normalizedNames.has(`${DEFAULT_COLLECTION_NAME.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }
  return `${DEFAULT_COLLECTION_NAME} ${suffix}`;
}

function nextTagName(tags: Tag[]): string {
  const normalizedNames = new Set(tags.map((tag) => tag.name.trim().toLowerCase()));
  if (!normalizedNames.has(DEFAULT_TAG_NAME.toLowerCase())) {
    return DEFAULT_TAG_NAME;
  }

  let suffix = 2;
  while (normalizedNames.has(`${DEFAULT_TAG_NAME.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }
  return `${DEFAULT_TAG_NAME} ${suffix}`;
}

function sortTagsByOrder(tags: Tag[]): Tag[] {
  return tags
    .slice()
    .sort((left, right) =>
      left.sortIndex !== right.sortIndex
        ? left.sortIndex - right.sortIndex
        : left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
}

function createItemId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `item-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function inferType(value: string, mimeType?: string): ItemType {
  const normalized = value.toLowerCase();
  if (mimeType?.startsWith("image/") || IMAGE_EXTENSIONS.test(normalized)) {
    return "image";
  }
  if (mimeType?.startsWith("video/") || VIDEO_EXTENSIONS.test(normalized)) {
    return "video";
  }
  if (mimeType === "application/pdf" || normalized.endsWith(".pdf")) {
    return "pdf";
  }
  return "file";
}

function fileTitleFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

function fileFormatFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return "";
  }
  return filename.slice(lastDot + 1).toLowerCase();
}

function normalizeAssetPath(filePath: string): string {
  return filePath
    .replace(/^file:\/\//i, "")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/");
}

function filenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? "imported-file";
}

function previewUrlFromVaultPath(vaultPath: string): string {
  return convertFileSrc(normalizeAssetPath(vaultPath));
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const sizeKb = sizeBytes / 1024;
  if (sizeKb < 1024) return `${Math.max(1, Math.round(sizeKb))} KB`;
  const sizeMb = sizeKb / 1024;
  if (sizeMb < 1024) return `${sizeMb.toFixed(1)} MB`;
  const sizeGb = sizeMb / 1024;
  return `${sizeGb.toFixed(2)} GB`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readPersistedPanelWidth(args: {
  key: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  if (typeof window === "undefined") {
    return args.fallback;
  }

  try {
    const raw = window.localStorage.getItem(args.key);
    if (!raw) return args.fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return args.fallback;
    return clampNumber(parsed, args.min, args.max);
  } catch {
    return args.fallback;
  }
}

function isTopbarSortOption(value: unknown): value is TopbarSortOption {
  return value === "newest" || value === "oldest" || value === "name-asc" || value === "rating-desc";
}

function readPersistedListViewControls(): PersistedListViewControls {
  const fallback: PersistedListViewControls = {
    searchQuery: "",
    sortOption: "newest",
    advancedFilters: createDefaultAdvancedItemFilters(),
  };

  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(LIST_VIEW_CONTROLS_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof PersistedListViewControls, unknown>>;
    return {
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : fallback.searchQuery,
      sortOption: isTopbarSortOption(parsed.sortOption) ? parsed.sortOption : fallback.sortOption,
      advancedFilters: normalizeAdvancedItemFilters(parsed.advancedFilters),
    };
  } catch {
    return fallback;
  }
}

function normalizeDate(dateValue: string): string {
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeItemType(value: string): ItemType {
  switch (value) {
    case "bookmark":
    case "image":
    case "video":
    case "pdf":
    case "file":
    case "note":
      return value;
    default:
      return "file";
  }
}

function normalizeThumbStatus(value: string | null | undefined, itemType: ItemType): ThumbStatus {
  if (itemType !== "image") {
    return "ready";
  }

  switch (value) {
    case "ready":
    case "pending":
    case "skipped":
    case "error":
      return value;
    default:
      return "pending";
  }
}

function normalizeImportStatus(value: string | null | undefined): ImportStatus {
  switch (value) {
    case "ready":
    case "processing":
    case "error":
      return value;
    default:
      return "ready";
  }
}

function normalizeBookmarkMetaStatus(
  value: string | null | undefined,
  itemType: ItemType,
): BookmarkMetaStatus {
  if (itemType !== "bookmark") {
    return "ready";
  }

  switch (value) {
    case "ready":
    case "pending":
    case "error":
      return value;
    default:
      return "ready";
  }
}

function deriveItemStatus(args: {
  itemType: ItemType;
  importStatus: ImportStatus;
  metaStatus: BookmarkMetaStatus;
}): ItemStatus {
  const { itemType, importStatus, metaStatus } = args;
  if (importStatus === "processing") return "processing";
  if (importStatus === "error") return "error";
  if (itemType === "bookmark" && metaStatus === "pending") return "processing";
  if (itemType === "bookmark" && metaStatus === "error") return "error";
  return "saved";
}

function formatDateFromTimestampMs(timestampMs: number): string {
  const parsed = new Date(timestampMs);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeItemRating(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Math.round(value)));
}

function shouldSkipThumbnailGeneration(args: {
  width?: number;
  height?: number;
}): boolean {
  const { width, height } = args;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  return hasDimensions && Math.max(width, height) <= THUMB_SKIP_MAX_DIMENSION;
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

class AsyncTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, label: string) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "AsyncTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function withAsyncTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new AsyncTimeoutError(timeoutMs, label));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

async function blobToPngBytes(blob: Blob): Promise<Uint8Array | null> {
  if (blob.type === "image/png") {
    return new Uint8Array(await blob.arrayBuffer());
  }

  if (typeof createImageBitmap !== "function") {
    return null;
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);

    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), "image/png"),
    );
    if (!pngBlob) return null;
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function normalizeHttpUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  return parsed.toString();
}

function hostnameFromUrl(urlValue: string): string {
  try {
    return new URL(urlValue).hostname || urlValue;
  } catch {
    return urlValue;
  }
}

async function readClipboardImageAsPngBytesFromPasteEvent(
  event: ClipboardEvent,
): Promise<Uint8Array | null> {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) {
    return null;
  }

  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const imageFile = item.getAsFile();
    if (!imageFile) continue;
    return blobToPngBytes(imageFile);
  }

  return null;
}

function createImportPlaceholderItem(args: {
  itemId?: string;
  filename: string;
  type: ItemType;
  collectionId: string | null;
  collectionPath: string;
  previewUrl?: string;
}): Item {
  const { itemId, filename, type, collectionId, collectionPath, previewUrl } = args;
  const now = new Date().toISOString().slice(0, 10);
  const membershipInstance =
    collectionId !== null
      ? {
          [collectionId]: {
            instanceId: createCollectionMembershipInstanceId(),
            collectionId,
            createdAt: Date.now(),
          },
        }
      : {};
  return {
    id: itemId ?? createItemId(),
    filename,
    type,
    title: fileTitleFromFilename(filename),
    description: "Importing...",
    rating: 0,
    isFavorite: false,
    status: "processing",
    importStatus: "processing",
    tagIds: [],
    tags: [],
    collectionId,
    collectionPath,
    collectionIds: collectionId ? [collectionId] : [],
    collectionInstancesByCollectionId: membershipInstance,
    createdAt: now,
    updatedAt: now,
    size: "-",
    format: fileFormatFromFilename(filename),
    previewUrl: type === "image" ? previewUrl : undefined,
    hasThumb: type !== "image",
    thumbStatus: type === "image" ? "pending" : "ready",
    metaStatus: "ready",
  };
}

function createBookmarkPlaceholderItem(args: {
  itemId?: string;
  url: string;
  collectionId: string | null;
  collectionPath: string;
}): Item {
  const { itemId, url, collectionId, collectionPath } = args;
  const now = new Date().toISOString().slice(0, 10);
  const hostname = hostnameFromUrl(url);
  const membershipInstance =
    collectionId !== null
      ? {
          [collectionId]: {
            instanceId: createCollectionMembershipInstanceId(),
            collectionId,
            createdAt: Date.now(),
          },
        }
      : {};
  return {
    id: itemId ?? createItemId(),
    filename: hostname,
    type: "bookmark",
    title: "Loading...",
    description: "Fetching bookmark metadata...",
    rating: 0,
    isFavorite: false,
    status: "processing",
    importStatus: "ready",
    tagIds: [],
    tags: [],
    collectionId,
    collectionPath,
    collectionIds: collectionId ? [collectionId] : [],
    collectionInstancesByCollectionId: membershipInstance,
    createdAt: now,
    updatedAt: now,
    size: "-",
    format: "url",
    hasThumb: true,
    thumbStatus: "ready",
    sourceUrl: url,
    hostname,
    metaStatus: "pending",
  };
}

function applyImportResultToItem(args: {
  item: Item;
  imported: ImportPipelineResult;
  itemType: ItemType;
}): Item {
  const { item, imported, itemType } = args;
  const vaultKey = buildVaultKey(imported.sha256, imported.ext);
  const thumbStatus = normalizeThumbStatus(imported.thumbStatus, itemType);
  const previewUrl =
    itemType === "image" ? previewUrlFromVaultPath(imported.vaultPath) : undefined;
  const thumbPath =
    itemType === "image"
      ? imported.thumbPath ?? (thumbStatus !== "skipped" ? item.thumbPath : undefined)
      : undefined;
  const thumbUrl =
    itemType === "image" && thumbStatus === "ready" && thumbPath
      ? previewUrlFromVaultPath(thumbPath)
      : undefined;
  const hasThumb = itemType === "image" && thumbStatus === "ready" && Boolean(thumbPath);
  const createdAt = normalizeDate(imported.createdAt);
  return {
    ...item,
    filename: imported.originalFilename,
    title: fileTitleFromFilename(imported.originalFilename),
    description: "Imported to vault storage.",
    status: "saved",
    importStatus: "ready",
    createdAt,
    updatedAt: createdAt,
    size: formatSize(imported.size),
    format: imported.ext,
    vaultKey,
    vaultPath: imported.vaultPath,
    previewUrl,
    thumbPath,
    thumbUrl,
    hasThumb,
    thumbStatus,
    width: imported.width ?? undefined,
    height: imported.height ?? undefined,
    sizeBytes: imported.size,
  };
}

type ImportSource =
  | {
      kind: "path";
      originalPath: string;
      filename: string;
      type: ItemType;
    }
  | {
      kind: "file";
      file: File;
      filename: string;
      type: ItemType;
    }
  | {
      kind: "bytes";
      bytes: Uint8Array;
      filename: string;
      type: ItemType;
      ext?: string;
    };

function previewUrlFromImportSource(source: ImportSource): string | undefined {
  if (source.type !== "image") {
    return undefined;
  }

  if (source.kind === "path") {
    return previewUrlFromVaultPath(source.originalPath);
  }

  if (source.kind === "file") {
    const maybePath = (source.file as File & { path?: string }).path;
    if (typeof maybePath === "string" && maybePath.trim().length > 0) {
      return previewUrlFromVaultPath(maybePath);
    }
    return URL.createObjectURL(source.file);
  }

  const mimeType = source.ext ? `image/${source.ext.toLowerCase()}` : "image/png";
  return URL.createObjectURL(new Blob([source.bytes], { type: mimeType }));
}

function toDbInsertItem(args: {
  item: Item;
  createdAtMs: number;
  updatedAtMs: number;
}): DbInsertItemInput {
  const { item, createdAtMs, updatedAtMs } = args;
  return {
    id: item.id,
    collectionId: item.collectionId,
    type: item.type,
    title: item.title,
    filename: item.filename,
    vaultKey: item.vaultKey ?? "",
    vaultPath: item.vaultPath ?? "",
    previewUrl: null,
    width: item.width ?? null,
    height: item.height ?? null,
    thumbStatus: item.thumbStatus,
    importStatus: item.importStatus,
    url: item.sourceUrl ?? null,
    faviconPath: item.faviconPath ?? null,
    metaStatus: item.metaStatus,
    description: item.description,
    rating: normalizeItemRating(item.rating),
    isFavorite: Boolean(item.isFavorite),
    createdAt: createdAtMs,
    updatedAt: updatedAtMs,
    tags: item.tags,
  };
}

function buildCollectionItemsByItemId(
  rows: DbCollectionItemRecord[],
): Map<string, DbCollectionItemRecord[]> {
  const rowsByItemId = new Map<string, DbCollectionItemRecord[]>();
  rows.forEach((row) => {
    const current = rowsByItemId.get(row.itemId);
    if (current) {
      current.push(row);
      return;
    }
    rowsByItemId.set(row.itemId, [row]);
  });
  return rowsByItemId;
}

function mapDbItemToItem(args: {
  item: DbItemRecord;
  collectionItemsByItemId: Map<string, DbCollectionItemRecord[]>;
  collectionPathById: Map<string, string>;
  thumbsRoot: string | null;
}): Item {
  const { item, collectionItemsByItemId, collectionPathById, thumbsRoot } = args;
  const itemType = normalizeItemType(item.type);
  const thumbStatus = normalizeThumbStatus(item.thumbStatus, itemType);
  const importStatus = normalizeImportStatus(item.importStatus);
  const metaStatus = normalizeBookmarkMetaStatus(item.metaStatus, itemType);
  const sourceUrl = item.url?.trim() ? item.url : undefined;
  const hostname = sourceUrl ? hostnameFromUrl(sourceUrl) : undefined;
  const faviconPath = item.faviconPath?.trim() ? item.faviconPath : undefined;
  const faviconUrl =
    itemType === "bookmark" && faviconPath ? previewUrlFromVaultPath(faviconPath) : undefined;
  const previewUrl =
    itemType === "image" && item.vaultPath.trim().length > 0
      ? previewUrlFromVaultPath(item.vaultPath)
      : undefined;
  const thumbPath =
    itemType === "image" &&
    item.vaultKey &&
    thumbsRoot
      ? buildThumbnailPath(thumbsRoot, item.vaultKey)
      : undefined;
  const hasThumb = itemType === "image" && thumbStatus === "ready";
  const thumbUrl = hasThumb && thumbPath ? previewUrlFromVaultPath(thumbPath) : undefined;
  const collectionMembershipRows = collectionItemsByItemId.get(item.id) ?? [];
  const collectionInstancesByCollectionId: Record<string, ItemCollectionMembershipInstance> = {};
  collectionMembershipRows.forEach((row) => {
    collectionInstancesByCollectionId[row.collectionId] = {
      instanceId: row.id,
      collectionId: row.collectionId,
      customTitle: row.customTitle ?? undefined,
      customDescription: row.customDescription ?? undefined,
      sortIndex: row.sortIndex,
      createdAt: row.createdAt,
    };
  });
  if (
    item.collectionId !== null &&
    !(item.collectionId in collectionInstancesByCollectionId)
  ) {
    collectionInstancesByCollectionId[item.collectionId] = {
      instanceId: `legacy-${item.id}-${item.collectionId}`,
      collectionId: item.collectionId,
      sortIndex: item.createdAt,
      createdAt: item.createdAt,
    };
  }
  const collectionIds = Object.keys(collectionInstancesByCollectionId);
  const primaryCollectionId =
    item.collectionId !== null && collectionInstancesByCollectionId[item.collectionId]
      ? item.collectionId
      : collectionIds[0] ?? null;
  return {
    id: item.id,
    filename: item.filename,
    type: itemType,
    title:
      itemType === "bookmark"
        ? item.title || hostname || sourceUrl || "Untitled bookmark"
        : item.title || fileTitleFromFilename(item.filename),
    description: item.description ?? "",
    rating: normalizeItemRating(item.rating),
    isFavorite: Boolean(item.isFavorite),
    status: deriveItemStatus({ itemType, importStatus, metaStatus }),
    importStatus,
    tagIds: item.tagIds ?? [],
    tags: item.tags ?? [],
    collectionId: primaryCollectionId,
    collectionPath:
      primaryCollectionId !== null
        ? collectionPathById.get(primaryCollectionId) ?? "All Items"
        : "All Items",
    collectionIds,
    collectionInstancesByCollectionId,
    createdAt: formatDateFromTimestampMs(item.createdAt),
    updatedAt: formatDateFromTimestampMs(item.updatedAt),
    size: "-",
    format: itemType === "bookmark" ? "url" : item.filename.split(".").pop()?.toLowerCase() ?? "",
    vaultKey: item.vaultKey,
    vaultPath: item.vaultPath,
    previewUrl,
    thumbPath,
    thumbUrl,
    faviconPath,
    faviconUrl,
    hasThumb: itemType !== "image" ? true : hasThumb,
    thumbStatus,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
    sourceUrl,
    hostname,
    metaStatus,
  };
}

function App() {
  const initialListViewControlsRef = useRef<PersistedListViewControls | null>(null);
  if (initialListViewControlsRef.current === null) {
    initialListViewControlsRef.current = readPersistedListViewControls();
  }
  const initialListViewControls = initialListViewControlsRef.current;

  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [items, setItems] = useState<Item[]>(initialItems);
  const [searchQuery, setSearchQuery] = useState(initialListViewControls.searchQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialListViewControls.searchQuery);
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>("all");
  const [sortOption, setSortOption] = useState<TopbarSortOption>(initialListViewControls.sortOption);
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedItemFilters>(
    initialListViewControls.advancedFilters,
  );
  const [tileSize, setTileSize] = useState(220);
  const [nativeDropEnabled, setNativeDropEnabled] = useState(false);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageModalItemId, setImageModalItemId] = useState<string | null>(null);
  const [deleteConfirmItemIds, setDeleteConfirmItemIds] = useState<string[]>([]);
  const [moveTargetItemIds, setMoveTargetItemIds] = useState<string[]>([]);
  const [deleteCollectionConfirm, setDeleteCollectionConfirm] = useState<{
    collectionId: string;
    collectionName: string;
    itemsCount: number;
    subcollectionsCount: number;
  } | null>(null);
  const [deleteTagConfirm, setDeleteTagConfirm] = useState<{
    tagId: string;
    tagName: string;
    itemsCount: number;
  } | null>(null);
  const [isActionInProgress, setIsActionInProgress] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [isItemDragActive, setIsItemDragActive] = useState(false);
  const [customItemDragState, setCustomItemDragState] = useState<CustomItemDragState | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarState | null>(null);
  const [sidebarCollectionDropState, setSidebarCollectionDropState] = useState<{
    collectionId: string;
    mode: "move" | "duplicate";
  } | null>(null);
  const [gridReorderDropState, setGridReorderDropState] = useState<GridReorderDropTarget | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    readPersistedPanelWidth({
      key: LEFT_PANEL_WIDTH_STORAGE_KEY,
      fallback: DEFAULT_LEFT_PANEL_WIDTH,
      min: LEFT_PANEL_WIDTH_MIN,
      max: LEFT_PANEL_WIDTH_MAX,
    }),
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    readPersistedPanelWidth({
      key: RIGHT_PANEL_WIDTH_STORAGE_KEY,
      fallback: DEFAULT_RIGHT_PANEL_WIDTH,
      min: RIGHT_PANEL_WIDTH_MIN,
      max: RIGHT_PANEL_WIDTH_MAX,
    }),
  );
  const [contextMenu, setContextMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    itemId: string | null;
  }>({
    open: false,
    x: 0,
    y: 0,
    itemId: null,
  });
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const filePickerInputRef = useRef<HTMLInputElement | null>(null);
  const thumbsRootRef = useRef<string | null>(null);
  const thumbnailQueueRef = useRef<ThumbnailQueue>(
    new ThumbnailQueue(THUMB_CONCURRENCY, THUMB_QUEUE_START_DELAY_MS),
  );
  const importQueueRef = useRef<DedupeAsyncQueue>(new DedupeAsyncQueue(IMPORT_QUEUE_CONCURRENCY));
  const bookmarkMetaQueueRef = useRef<DedupeAsyncQueue>(
    new DedupeAsyncQueue(BOOKMARK_META_QUEUE_CONCURRENCY),
  );
  const importSourceByItemIdRef = useRef<Map<string, ImportSource>>(new Map());
  const transientPreviewUrlByItemIdRef = useRef<Map<string, string>>(new Map());
  const imageEvaluationQueueRef = useRef<DedupeAsyncQueue>(new DedupeAsyncQueue(1));
  const imageThumbnailEvaluationRequestedRef = useRef<Set<string>>(new Set());
  const isUserInteractingRef = useRef(false);
  const userInteractionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  const itemsRef = useRef<Item[]>(initialItems);
  const pendingUndoableActionRef = useRef<PendingUndoableAction | null>(null);
  const snackbarSequenceRef = useRef(0);
  const snackbarInfoTimeoutRef = useRef<number | null>(null);
  const activeItemDragPayloadRef = useRef<SidebarItemDragPayload | null>(null);
  const activeItemDragAltRef = useRef(false);
  const keyboardAltPressedRef = useRef(false);
  const pointerItemDragCandidateRef = useRef<PointerItemDragCandidate | null>(null);
  const activeCustomItemDragRef = useRef<CustomItemDragState | null>(null);
  const gridReorderDropStateRef = useRef<GridReorderDropTarget | null>(null);
  const suppressNextItemClickRef = useRef(0);
  const descriptionDraftByItemIdRef = useRef<Map<string, string>>(new Map());
  const [descriptionPersistRequest, setDescriptionPersistRequest] = useState<{
    itemId: string;
    description: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const deferredSearchQuery = useDeferredValue(debouncedSearchQuery);

  const collectionTree = useMemo(() => buildCollectionTree(collections), [collections]);
  const collectionPathById = useMemo(
    () => buildCollectionPathMap(collections),
    [collections],
  );
  const tagById = useMemo(() => {
    const map = new Map<string, Tag>();
    tags.forEach((tag) => {
      map.set(tag.id, tag);
    });
    return map;
  }, [tags]);

  const selectedCollectionPath =
    selectedCollectionId !== null
      ? collectionPathById.get(selectedCollectionId) ?? "All Items"
      : "All Items";
  const activeTagFilter = selectedTagId ? tagById.get(selectedTagId) ?? null : null;
  const hasActiveGridSubsetFilter =
    libraryViewMode === "favorites" ||
    selectedTagId !== null ||
    searchQuery.trim().length > 0 ||
    hasActiveAdvancedItemFilters(advancedFilters);

  const activeTopbarFilterChips = useMemo<TopbarFilterChip[]>(() => {
    const chips: TopbarFilterChip[] = [];

    if (activeTagFilter) {
      chips.push({
        id: `sidebar-tag:${activeTagFilter.id}`,
        label: `#${activeTagFilter.name}`,
        color: activeTagFilter.color,
        title: `Clear sidebar tag filter: ${activeTagFilter.name}`,
      });
    }

    advancedFilters.tagIds.forEach((tagId) => {
      const tag = tagById.get(tagId);
      chips.push({
        id: `tag:${tagId}`,
        label: `#${tag?.name ?? tagId}`,
        ...(tag?.color ? { color: tag.color } : {}),
        title: tag ? `Remove tag filter: ${tag.name}` : "Remove tag filter",
      });
    });

    advancedFilters.types.forEach((typeValue) => {
      chips.push({
        id: `type:${typeValue}`,
        label: formatAdvancedItemFilterTypeLabel(typeValue),
      });
    });

    if (advancedFilters.minRating > 0) {
      chips.push({
        id: "rating",
        label: `Rating >= ${advancedFilters.minRating}`,
      });
    }

    if (advancedFilters.favoritesOnly) {
      chips.push({
        id: "favorites",
        label: "Favorites",
      });
    }

    return chips;
  }, [activeTagFilter, advancedFilters, tagById]);

  const handleRemoveTopbarFilterChip = useCallback((chipId: string) => {
    if (chipId.startsWith("sidebar-tag:")) {
      setSelectedTagId(null);
      return;
    }

    if (chipId.startsWith("tag:")) {
      const tagId = chipId.slice("tag:".length);
      setAdvancedFilters((current) => {
        if (!current.tagIds.includes(tagId)) {
          return current;
        }
        return {
          ...current,
          tagIds: current.tagIds.filter((entry) => entry !== tagId),
        };
      });
      return;
    }

    if (chipId.startsWith("type:")) {
      const typeValue = chipId.slice("type:".length) as AdvancedItemFilterType;
      setAdvancedFilters((current) => {
        if (!current.types.includes(typeValue)) {
          return current;
        }
        return {
          ...current,
          types: current.types.filter((entry) => entry !== typeValue),
        };
      });
      return;
    }

    if (chipId === "rating") {
      setAdvancedFilters((current) =>
        current.minRating === 0
          ? current
          : {
              ...current,
              minRating: 0,
            },
      );
      return;
    }

    if (chipId === "favorites") {
      setAdvancedFilters((current) =>
        !current.favoritesOnly
          ? current
          : {
              ...current,
              favoritesOnly: false,
            },
      );
    }
  }, []);

  const handleClearAllTopbarFilters = useCallback(() => {
    setSelectedTagId(null);
    setAdvancedFilters(createDefaultAdvancedItemFilters());
  }, []);

  const handleSidebarSelectCollection = useCallback((collectionId: string | null) => {
    if (collectionId !== null) {
      setLibraryViewMode("all");
    }
    setSelectedCollectionId(collectionId);
  }, []);

  const handleSidebarSelectTag = useCallback((tagId: string | null) => {
    if (tagId !== null) {
      setLibraryViewMode("all");
    }
    setSelectedTagId(tagId);
  }, []);

  const handleSidebarSelectMenuView = useCallback((menuLabel: string) => {
    setLibraryViewMode(menuLabel === "Favorites" ? "favorites" : "all");
  }, []);

  const reloadItemsFromDb = useCallback(
    async (collectionsOverride?: Collection[]) => {
      const persistedState = await loadDbAppState();
      const activeCollections = collectionsOverride ?? collections;
      const pathById = buildCollectionPathMap(activeCollections);
      const collectionItemsByItemId = buildCollectionItemsByItemId(
        persistedState.collectionItems ?? [],
      );
      const mappedItems = persistedState.items.map((item) =>
        mapDbItemToItem({
          item,
          collectionItemsByItemId,
          collectionPathById: pathById,
          thumbsRoot: thumbsRootRef.current,
        }),
      );
      setTags(persistedState.tags ?? []);
      setItems(mappedItems);
    },
    [collections],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setDebouncedSearchQuery(searchQuery);
      });
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [searchQuery]);

  useEffect(() => {
    if (selectedTagId && !tags.some((tag) => tag.id === selectedTagId)) {
      setSelectedTagId(null);
    }
  }, [tags, selectedTagId]);

  useEffect(() => {
    const validTagIds = new Set(tags.map((tag) => tag.id));
    setAdvancedFilters((current) => {
      if (current.tagIds.length === 0) {
        return current;
      }
      const nextTagIds = current.tagIds.filter((tagId) => validTagIds.has(tagId));
      if (nextTagIds.length === current.tagIds.length) {
        return current;
      }
      return {
        ...current,
        tagIds: nextTagIds,
      };
    });
  }, [tags]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LIST_VIEW_CONTROLS_STORAGE_KEY,
        JSON.stringify({
          searchQuery,
          sortOption,
          advancedFilters,
        } satisfies PersistedListViewControls),
      );
    } catch {
      // ignore localStorage write errors
    }
  }, [advancedFilters, searchQuery, sortOption]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_PANEL_WIDTH_STORAGE_KEY, String(leftPanelWidth));
    } catch {
      // ignore localStorage write errors
    }
  }, [leftPanelWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
    } catch {
      // ignore localStorage write errors
    }
  }, [rightPanelWidth]);

  const startPanelResize = useCallback(
    (panel: "left" | "right", startClientX: number) => {
      const startingWidth = panel === "left" ? leftPanelWidth : rightPanelWidth;

      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const handleMouseMove = (event: MouseEvent) => {
        const deltaX = event.clientX - startClientX;
        if (panel === "left") {
          setLeftPanelWidth(
            clampNumber(startingWidth + deltaX, LEFT_PANEL_WIDTH_MIN, LEFT_PANEL_WIDTH_MAX),
          );
          return;
        }

        setRightPanelWidth(
          clampNumber(startingWidth - deltaX, RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX),
        );
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [leftPanelWidth, rightPanelWidth],
  );

  const handleStartLeftPanelResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      startPanelResize("left", event.clientX);
    },
    [startPanelResize],
  );

  const handleStartRightPanelResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      startPanelResize("right", event.clientX);
    },
    [startPanelResize],
  );

  const createCollection = useCallback(
    async (parentId: string | null): Promise<Collection | null> => {
      const generatedName = nextCollectionName(collections);
      try {
        const createdCollection = await createCollectionInDb({
          name: generatedName,
          parentId,
          icon: DEFAULT_COLLECTION_ICON,
          color: DEFAULT_COLLECTION_COLOR,
          description: "",
        });
        setCollections((currentCollections) => [...currentCollections, createdCollection]);
        setSelectedCollectionId(createdCollection.id);
        return createdCollection;
      } catch (error) {
        console.error("Failed to create collection:", error);
        return null;
      }
    },
    [collections],
  );

  const renameCollection = useCallback(async (id: string, newName: string): Promise<boolean> => {
    const trimmedName = newName.trim();
    if (trimmedName.length === 0) {
      return false;
    }
    try {
      const updatedAt = await updateCollectionNameInDb(id, trimmedName);
      setCollections((currentCollections) =>
        currentCollections.map((collection) =>
          collection.id === id ? { ...collection, name: trimmedName, updatedAt } : collection,
        ),
      );
      return true;
    } catch (error) {
      console.error("Failed to rename collection:", error);
      return false;
    }
  }, []);

  const getCollectionDeleteImpact = useCallback(
    (collectionId: string) => {
      const subtreeIds = collectCollectionSubtreeIds(collections, collectionId);
      const itemsCount = items.reduce((count, item) => {
        const hasSubtreeMembership = item.collectionIds.some((id) => subtreeIds.has(id));
        const hasOutsideMembership = item.collectionIds.some((id) => !subtreeIds.has(id));
        if (hasSubtreeMembership && !hasOutsideMembership) {
          return count + 1;
        }
        return count;
      }, 0);
      return {
        subtreeIds,
        itemsCount,
        subcollectionsCount: Math.max(0, subtreeIds.size - 1),
      };
    },
    [collections, items],
  );

  const requestDeleteCollection = useCallback(
    (id: string, name: string) => {
      const collectionExists = collections.some((collection) => collection.id === id);
      if (!collectionExists) {
        return;
      }
      const impact = getCollectionDeleteImpact(id);
      setDeleteCollectionConfirm({
        collectionId: id,
        collectionName: name,
        itemsCount: impact.itemsCount,
        subcollectionsCount: impact.subcollectionsCount,
      });
    },
    [collections, getCollectionDeleteImpact],
  );

  const performDeleteCollection = useCallback(async () => {
    const pendingDelete = deleteCollectionConfirm;
    if (!pendingDelete) return;

    const { collectionId } = pendingDelete;
    const collectionsSnapshot = [...collections];
    const itemsSnapshot = [...items];
    const selectedCollectionIdSnapshot = selectedCollectionId;
    const selectedIdsSnapshot = [...selectedIds];
    const selectionAnchorIdSnapshot = selectionAnchorId;
    const descriptionPersistRequestSnapshot = descriptionPersistRequest
      ? { ...descriptionPersistRequest }
      : null;
    const targetCollection = collections.find((collection) => collection.id === collectionId);
    if (!targetCollection) {
      setDeleteCollectionConfirm(null);
      return;
    }

    const { subtreeIds } = getCollectionDeleteImpact(collectionId);
    const removedItems = items.filter((item) => {
      const hasSubtreeMembership = item.collectionIds.some((id) => subtreeIds.has(id));
      const hasOutsideMembership = item.collectionIds.some((id) => !subtreeIds.has(id));
      return hasSubtreeMembership && !hasOutsideMembership;
    });
    const removedItemIds = new Set(removedItems.map((item) => item.id));
    const nextCollectionPathById = new Map<string, string>();

    setIsActionInProgress(true);
    try {
      await deleteCollectionInDb(collectionId);
      const refreshedCollections = await getAllCollectionsInDb();
      buildCollectionPathMap(refreshedCollections).forEach((value, key) => {
        nextCollectionPathById.set(key, value);
      });
      setCollections(refreshedCollections);
      setSelectedCollectionId((currentSelectedCollectionId) => {
        if (!currentSelectedCollectionId) return currentSelectedCollectionId;
        if (!subtreeIds.has(currentSelectedCollectionId)) {
          return currentSelectedCollectionId;
        }

        const fallbackParentId = targetCollection.parentId ?? null;
        if (
          fallbackParentId &&
          refreshedCollections.some((collection) => collection.id === fallbackParentId)
        ) {
          return fallbackParentId;
        }
        return null;
      });
    } catch (error) {
      console.error("Failed to delete collection:", error);
      return;
    } finally {
      setIsActionInProgress(false);
    }

    setDeleteCollectionConfirm(null);
    if (removedItemIds.size === 0) {
      setItems((currentItems) =>
        currentItems.map((item) => {
          const hasSubtreeMembership = item.collectionIds.some((id) => subtreeIds.has(id));
          if (!hasSubtreeMembership) {
            return item;
          }
          let nextItem = item;
          item.collectionIds.forEach((membershipCollectionId) => {
            if (!subtreeIds.has(membershipCollectionId)) {
              return;
            }
            nextItem = removeCollectionMembershipFromItem({
              item: nextItem,
              collectionId: membershipCollectionId,
              collectionPathById: nextCollectionPathById,
            });
          });
          return nextItem;
        }),
      );
    } else {
      setItems((currentItems) =>
        currentItems
          .filter((item) => !removedItemIds.has(item.id))
          .map((item) => {
            const hasSubtreeMembership = item.collectionIds.some((id) => subtreeIds.has(id));
            if (!hasSubtreeMembership) {
              return item;
            }
            let nextItem = item;
            item.collectionIds.forEach((membershipCollectionId) => {
              if (!subtreeIds.has(membershipCollectionId)) {
                return;
              }
              nextItem = removeCollectionMembershipFromItem({
                item: nextItem,
                collectionId: membershipCollectionId,
                collectionPathById: nextCollectionPathById,
              });
            });
            return nextItem;
          }),
      );
      setSelectedIds((currentSelectedIds) =>
        currentSelectedIds.filter((itemId) => !removedItemIds.has(itemId)),
      );
      setSelectionAnchorId((currentAnchorId) =>
        currentAnchorId !== null && removedItemIds.has(currentAnchorId) ? null : currentAnchorId,
      );
      setDescriptionPersistRequest((current) =>
        current && removedItemIds.has(current.itemId) ? null : current,
      );
    }
    const finalizeRemovedItemsCleanup = () => {
      removedItems.forEach((item) => {
        const previewUrl = transientPreviewUrlByItemIdRef.current.get(item.id);
        if (previewUrl) {
          transientPreviewUrlByItemIdRef.current.delete(item.id);
          if (previewUrl.startsWith("blob:")) {
            URL.revokeObjectURL(previewUrl);
          }
        }
        descriptionDraftByItemIdRef.current.delete(item.id);
      });
    };

    if (snackbarInfoTimeoutRef.current !== null) {
      window.clearTimeout(snackbarInfoTimeoutRef.current);
      snackbarInfoTimeoutRef.current = null;
    }
    if (pendingUndoableActionRef.current) {
      const pending = pendingUndoableActionRef.current;
      pendingUndoableActionRef.current = null;
      window.clearTimeout(pending.timeoutId);
      setSnackbar((current) => (current?.id === pending.id ? null : current));
      try {
        await pending.commit();
        pending.finalizeUi?.();
      } catch (error) {
        console.error("Failed to commit pending action before delete-collection snackbar:", error);
        pending.undoUi();
      }
    }

    const deleteCollectionSnackbarId = ++snackbarSequenceRef.current;
    const deleteCollectionTimeoutId = window.setTimeout(() => {
      const pending = pendingUndoableActionRef.current;
      if (!pending || pending.id !== deleteCollectionSnackbarId) {
        return;
      }
      pendingUndoableActionRef.current = null;
      window.clearTimeout(pending.timeoutId);
      setSnackbar((current) => (current?.id === pending.id ? null : current));
      void pending
        .commit()
        .then(() => {
          pending.finalizeUi?.();
        })
        .catch((error) => {
          console.error("Delete collection snackbar finalize failed:", error);
          pending.undoUi();
        });
    }, UNDO_SNACKBAR_TIMEOUT_MS);

    pendingUndoableActionRef.current = {
      id: deleteCollectionSnackbarId,
      commit: async () => {},
      undoUi: () => {
        setCollections(collectionsSnapshot);
        setItems(itemsSnapshot);
        setSelectedCollectionId(selectedCollectionIdSnapshot);
        setSelectedIds(selectedIdsSnapshot);
        setSelectionAnchorId(selectionAnchorIdSnapshot);
        setDescriptionPersistRequest(descriptionPersistRequestSnapshot);
        setDeleteCollectionConfirm(null);
      },
      finalizeUi: finalizeRemovedItemsCleanup,
      timeoutId: deleteCollectionTimeoutId,
    };

    setSnackbar({
      id: deleteCollectionSnackbarId,
      message: `Deleted collection "${targetCollection.name}" (${pendingDelete.itemsCount} items, ${pendingDelete.subcollectionsCount} sub-collections)`,
      actionKind: "delete",
      visibleUntil: Date.now() + UNDO_SNACKBAR_TIMEOUT_MS,
      canUndo: true,
    });
  }, [
    deleteCollectionConfirm,
    collections,
    items,
    getCollectionDeleteImpact,
    selectedCollectionId,
    selectedIds,
    selectionAnchorId,
    descriptionPersistRequest,
  ]);

  const handleConfirmDeleteCollection = useCallback(() => {
    if (isActionInProgress) return;
    void performDeleteCollection();
  }, [isActionInProgress, performDeleteCollection]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!selectedCollectionId) return;
    if (collections.some((collection) => collection.id === selectedCollectionId)) return;
    setSelectedCollectionId(null);
  }, [collections, selectedCollectionId]);

  useEffect(() => {
    setItems((currentItems) => {
      let hasChanges = false;
      const nextItems = currentItems.map((item) => {
        const nextCollectionPath =
          item.collectionId !== null
            ? collectionPathById.get(item.collectionId) ?? "All Items"
            : "All Items";
        if (item.collectionPath === nextCollectionPath) {
          return item;
        }
        hasChanges = true;
        return { ...item, collectionPath: nextCollectionPath };
      });
      return hasChanges ? nextItems : currentItems;
    });
  }, [collectionPathById]);

  useEffect(() => {
    const validIds = new Set(items.map((item) => item.id));
    imageThumbnailEvaluationRequestedRef.current.forEach((itemId) => {
      if (!validIds.has(itemId)) {
        imageThumbnailEvaluationRequestedRef.current.delete(itemId);
      }
    });
  }, [items]);

  const releaseTransientPreviewUrl = useCallback((itemId: string) => {
    const previewUrl = transientPreviewUrlByItemIdRef.current.get(itemId);
    if (!previewUrl) return;
    transientPreviewUrlByItemIdRef.current.delete(itemId);
    if (previewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrl);
    }
  }, []);

  const persistItemMediaState = useCallback(
    (params: {
      itemId: string;
      width?: number | null;
      height?: number | null;
      thumbStatus?: ThumbStatus;
    }) => {
      void updateItemMediaStateInDb({
        itemId: params.itemId,
        width: params.width,
        height: params.height,
        thumbStatus: params.thumbStatus,
      }).catch((error) => {
        console.error("Failed to persist item media state:", params.itemId, error);
      });
    },
    [],
  );

  const persistBookmarkMetadataState = useCallback(
    async (params: {
      itemId: string;
      metaStatus: BookmarkMetaStatus;
      url?: string | null;
      title?: string | null;
      filename?: string | null;
      faviconPath?: string | null;
    }) =>
      updateItemBookmarkMetadataInDb({
        itemId: params.itemId,
        metaStatus: params.metaStatus,
        url: params.url,
        title: params.title,
        filename: params.filename,
        faviconPath: params.faviconPath,
      }),
    [],
  );

  const applyBookmarkMetadataSuccess = useCallback(
    async (itemId: string, requestedUrl: string, metadata: BookmarkMetadataFetchResult) => {
      const finalUrl = normalizeHttpUrlInput(metadata.finalUrl) ?? requestedUrl;
      const currentItem = itemsRef.current.find((candidate) => candidate.id === itemId) ?? null;
      const nextHostname = hostnameFromUrl(finalUrl);
      const currentTitle =
        currentItem?.title && currentItem.title !== "Loading..." ? currentItem.title : "";
      const nextTitle =
        metadata.title?.trim() || currentTitle || nextHostname || finalUrl;
      const nextFilename = nextHostname || currentItem?.filename || "bookmark";
      const nextFaviconPath = metadata.faviconPath?.trim() || currentItem?.faviconPath;
      const updatedAtMs = await persistBookmarkMetadataState({
        itemId,
        metaStatus: "ready",
        url: finalUrl,
        title: nextTitle,
        filename: nextFilename,
        faviconPath: metadata.faviconPath ?? null,
      });
      if (isUnmountedRef.current) return;

      setItems((currentItems) =>
        currentItems.map((item) => {
          if (item.id !== itemId || item.type !== "bookmark") {
            return item;
          }
          const faviconUrl = nextFaviconPath ? previewUrlFromVaultPath(nextFaviconPath) : undefined;
          const nextMetaStatus: BookmarkMetaStatus = "ready";
          const nextDescription =
            item.description === "Fetching bookmark metadata..." ? "" : item.description;
          return {
            ...item,
            title: nextTitle,
            filename: nextFilename,
            sourceUrl: finalUrl,
            hostname: nextHostname,
            faviconPath: nextFaviconPath,
            faviconUrl,
            metaStatus: nextMetaStatus,
            description: nextDescription,
            status: deriveItemStatus({
              itemType: "bookmark",
              importStatus: item.importStatus,
              metaStatus: nextMetaStatus,
            }),
            updatedAt: formatDateFromTimestampMs(updatedAtMs),
          };
        }),
      );
    },
    [persistBookmarkMetadataState],
  );

  const applyBookmarkMetadataError = useCallback(
    async (itemId: string, error: unknown) => {
      console.error("Bookmark metadata job failed:", itemId, error);
      let updatedAtMs: number | null = null;
      try {
        updatedAtMs = await persistBookmarkMetadataState({
          itemId,
          metaStatus: "error",
        });
      } catch (dbError) {
        console.error("Failed to persist bookmark metadata error:", itemId, dbError);
      }
      if (isUnmountedRef.current) return;

      setItems((currentItems) =>
        currentItems.map((item) => {
          if (item.id !== itemId || item.type !== "bookmark") {
            return item;
          }
          const nextMetaStatus: BookmarkMetaStatus = "error";
          const fallbackTitle =
            item.title === "Loading..." ? item.hostname || item.sourceUrl || "Bookmark" : item.title;
          return {
            ...item,
            title: fallbackTitle,
            description:
              item.description === "Fetching bookmark metadata..."
                ? "Bookmark metadata unavailable."
                : item.description,
            metaStatus: nextMetaStatus,
            status: deriveItemStatus({
              itemType: "bookmark",
              importStatus: item.importStatus,
              metaStatus: nextMetaStatus,
            }),
            updatedAt:
              updatedAtMs !== null ? formatDateFromTimestampMs(updatedAtMs) : item.updatedAt,
          };
        }),
      );
    },
    [persistBookmarkMetadataState],
  );

  const enqueueBookmarkMetadataJob = useCallback(
    (itemId: string, fallbackUrl?: string) => {
      const queueItem = itemsRef.current.find((candidate) => candidate.id === itemId) ?? null;
      const sourceUrl =
        queueItem?.type === "bookmark" && queueItem.sourceUrl ? queueItem.sourceUrl : fallbackUrl;
      if (!sourceUrl) {
        return;
      }
      const dedupeKey = `${itemId}:${sourceUrl}`;
      console.log("[bookmark-queue] enqueue", { itemId, url: sourceUrl });
      bookmarkMetaQueueRef.current.enqueue({
        dedupeKey,
        run: async () => {
          const latest = itemsRef.current.find((candidate) => candidate.id === itemId);
          const activeUrl =
            latest?.type === "bookmark" && latest.sourceUrl ? latest.sourceUrl : sourceUrl;
          const maxAttempts = BOOKMARK_META_JOB_MAX_RETRIES + 1;
          let lastError: unknown = new Error("Bookmark metadata fetch did not run.");

          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
              console.log("[bookmark-queue] start", { itemId, url: activeUrl, attempt });
              const startedAt = Date.now();
              const metadata = await withAsyncTimeout(
                fetchBookmarkMetadata(activeUrl),
                BOOKMARK_META_JOB_TIMEOUT_MS,
                "bookmark metadata fetch",
              );
              await applyBookmarkMetadataSuccess(itemId, activeUrl, metadata);
              console.log("[bookmark-queue] finish", {
                itemId,
                status: "success",
                attempt,
                durationMs: Date.now() - startedAt,
                finalUrl: metadata.finalUrl,
                hasTitle: Boolean(metadata.title),
                hasFavicon: Boolean(metadata.faviconPath),
                faviconUrlCandidate: metadata.faviconUrlCandidate,
              });
              await yieldToMainThread();
              return;
            } catch (error) {
              lastError = error;
              if (attempt < maxAttempts) {
                console.warn("[bookmark-queue] retry", { itemId, attempt, url: activeUrl, error });
                continue;
              }
            }
          }

          console.error("[bookmark-queue] finish", {
            itemId,
            status: "error",
            url: activeUrl,
            error: lastError,
          });
          await applyBookmarkMetadataError(itemId, lastError);
          await yieldToMainThread();
        },
        onError: (error) => {
          console.error("[bookmark-queue] crashed", { itemId, url: sourceUrl, error });
        },
      });
    },
    [applyBookmarkMetadataError, applyBookmarkMetadataSuccess],
  );

  const queueBookmarkUrls = useCallback(
    async (rawUrls: string[]) => {
      const normalizedUrls = Array.from(
        new Set(
          rawUrls
            .map((value) => normalizeHttpUrlInput(value))
            .filter((value): value is string => Boolean(value)),
        ),
      );
      if (normalizedUrls.length === 0) return;

      const placeholders = normalizedUrls.map((url) =>
        createBookmarkPlaceholderItem({
          url,
          collectionId: selectedCollectionId,
          collectionPath: selectedCollectionPath,
        }),
      );
      const baseTimestamp = Date.now();

      try {
        await insertItemsInDb(
          placeholders.map((item, index) =>
            toDbInsertItem({
              item,
              createdAtMs: baseTimestamp + index,
              updatedAtMs: baseTimestamp + index,
            }),
          ),
        );
      } catch (error) {
        console.error("Failed to insert bookmark placeholders:", error);
        return;
      }

      if (isUnmountedRef.current) {
        return;
      }

      setItems((currentItems) => [...placeholders, ...currentItems]);
      const placeholderIds = placeholders.map((item) => item.id);
      setSelectedIds(placeholderIds);
      setSelectionAnchorId(placeholderIds[placeholderIds.length - 1] ?? null);
      await yieldToMainThread();

      if (isUnmountedRef.current) {
        return;
      }

      placeholders.forEach((placeholder) => {
        enqueueBookmarkMetadataJob(placeholder.id, placeholder.sourceUrl);
      });
    },
    [
      selectedCollectionId,
      selectedCollectionPath,
      enqueueBookmarkMetadataJob,
    ],
  );

  const persistThumbStatusForVaultKey = useCallback(
    (vaultKey: string, thumbStatus: ThumbStatus, fallbackItemId?: string) => {
      const targetIds = Array.from(
        new Set(
          itemsRef.current
            .filter(
              (candidate) => candidate.type === "image" && candidate.vaultKey === vaultKey,
            )
            .map((candidate) => candidate.id),
        ),
      );
      if (targetIds.length === 0 && fallbackItemId) {
        targetIds.push(fallbackItemId);
      }

      targetIds.forEach((itemId) => {
        persistItemMediaState({ itemId, thumbStatus });
      });
    },
    [persistItemMediaState],
  );

  const queueThumbnailGeneration = useCallback((item: Item) => {
    if (item.type !== "image" || !item.vaultPath || !item.vaultKey) {
      return;
    }
    const vaultKey = item.vaultKey;

    const thumbsRoot = thumbsRootRef.current;
    if (!thumbsRoot) {
      setItems((currentItems) =>
        currentItems.map((currentItem) =>
          currentItem.type === "image" && currentItem.vaultKey === vaultKey
            ? { ...currentItem, hasThumb: false, thumbStatus: "error" }
            : currentItem,
        ),
      );
      persistThumbStatusForVaultKey(vaultKey, "error", item.id);
      return;
    }

    let thumbPath = item.thumbPath;
    if (!thumbPath) {
      try {
        thumbPath = buildThumbnailPath(thumbsRoot, vaultKey);
      } catch (error) {
        console.error("Failed to build thumbnail path:", vaultKey, error);
        setItems((currentItems) =>
          currentItems.map((currentItem) =>
            currentItem.type === "image" && currentItem.vaultKey === vaultKey
              ? { ...currentItem, hasThumb: false, thumbStatus: "error" }
              : currentItem,
          ),
        );
        persistThumbStatusForVaultKey(vaultKey, "error", item.id);
        return;
      }
    }

    setItems((currentItems) =>
      currentItems.map((currentItem) =>
        currentItem.type === "image" && currentItem.vaultKey === vaultKey
          ? {
              ...currentItem,
              thumbPath,
              thumbUrl: undefined,
              hasThumb: false,
              thumbStatus: "pending",
            }
          : currentItem,
      ),
    );
    persistThumbStatusForVaultKey(vaultKey, "pending", item.id);

    console.log("ENQUEUE THUMB", item.id);
    thumbnailQueueRef.current.enqueue({
      dedupeKey: item.id,
      itemId: item.id,
      inputPath: item.vaultPath,
      outputPath: thumbPath,
      maxSize: THUMB_MAX_SIZE,
      timeoutMs: THUMB_JOB_TIMEOUT_MS,
      maxRetries: THUMB_JOB_MAX_RETRIES,
      onSuccess: (generatedPath) => {
        if (isUnmountedRef.current) return;
        const generatedUrl = previewUrlFromVaultPath(generatedPath);
        setItems((currentItems) =>
          currentItems.map((currentItem) =>
            currentItem.type === "image" && currentItem.vaultKey === vaultKey
              ? {
                  ...currentItem,
                  thumbPath: generatedPath,
                  thumbUrl: generatedUrl,
                  hasThumb: true,
                  thumbStatus: "ready",
                }
              : currentItem,
          ),
        );
        persistThumbStatusForVaultKey(vaultKey, "ready", item.id);
      },
      onError: (error) => {
        if (isUnmountedRef.current) return;
        console.error("Thumbnail generation failed:", item.vaultPath, error);
        setItems((currentItems) =>
          currentItems.map((currentItem) =>
            currentItem.type === "image" && currentItem.vaultKey === vaultKey
              ? { ...currentItem, thumbUrl: undefined, hasThumb: false, thumbStatus: "error" }
              : currentItem,
          ),
        );
        persistThumbStatusForVaultKey(vaultKey, "error", item.id);
      },
    });
  }, [persistThumbStatusForVaultKey]);

  const evaluateImageThumbnailStateNow = useCallback(
    async (item: Item, options?: { force?: boolean }) => {
      if (item.type !== "image") {
        console.log("[thumb-eval] early-return non-image", { itemId: item.id, type: item.type });
        return;
      }

      const force = options?.force ?? false;
      const width = item.width;
      const height = item.height;
      const vaultKey = item.vaultKey;
      const vaultPath = item.vaultPath;

      if (!vaultKey || !vaultPath) {
        console.log("[thumb-eval] early-return missing-vault", {
          itemId: item.id,
          vaultKey: Boolean(vaultKey),
          vaultPath: Boolean(vaultPath),
          force,
        });
        return;
      }

      if (typeof width !== "number" || typeof height !== "number") {
        console.log("[thumb-eval] width-height-missing", {
          itemId: item.id,
          width,
          height,
          force,
        });
      }

      if (!force && item.thumbStatus === "skipped") {
        console.log("[thumb-eval] early-return skipped-status", {
          itemId: item.id,
          thumbStatus: item.thumbStatus,
          force,
        });
        return;
      }

      if (
        shouldSkipThumbnailGeneration({
          width,
          height,
        })
      ) {
        console.log("[thumb-eval] early-return max-dimension-skip", {
          itemId: item.id,
          width,
          height,
          threshold: THUMB_SKIP_MAX_DIMENSION,
          force,
        });
        setItems((currentItems) =>
          currentItems.map((currentItem) =>
            currentItem.type === "image" && currentItem.vaultKey === vaultKey
              ? {
                  ...currentItem,
                  width: currentItem.width ?? width,
                  height: currentItem.height ?? height,
                  thumbPath: undefined,
                  thumbUrl: undefined,
                  hasThumb: false,
                  thumbStatus: "skipped",
                }
              : currentItem,
          ),
        );
        persistThumbStatusForVaultKey(vaultKey, "skipped", item.id);
        persistItemMediaState({
          itemId: item.id,
          width: width ?? null,
          height: height ?? null,
          thumbStatus: "skipped",
        });
        return;
      }

      let thumbPath = item.thumbPath;
      if (!thumbPath) {
        const thumbsRoot = thumbsRootRef.current;
        if (thumbsRoot) {
          try {
            thumbPath = buildThumbnailPath(thumbsRoot, vaultKey);
          } catch (error) {
            console.error("Failed to build thumbnail path before enqueue:", vaultKey, error);
          }
        }
      }

      if (thumbPath) {
        try {
          const hasThumbOnDisk = await fileExists(thumbPath);
          if (hasThumbOnDisk) {
            console.log("[thumb-eval] early-return thumb-exists", {
              itemId: item.id,
              thumbPath,
              force,
            });
            const thumbUrl = previewUrlFromVaultPath(thumbPath);
            setItems((currentItems) =>
              currentItems.map((currentItem) =>
                currentItem.type === "image" && currentItem.vaultKey === vaultKey
                  ? {
                      ...currentItem,
                      thumbPath,
                      thumbUrl,
                      hasThumb: true,
                      thumbStatus: "ready",
                    }
                  : currentItem,
              ),
            );
            persistThumbStatusForVaultKey(vaultKey, "ready", item.id);
            return;
          }
        } catch (error) {
          console.warn("Failed to check thumbnail existence before enqueue:", thumbPath, error);
        }
      }

      if (!force && item.thumbStatus === "ready" && item.hasThumb) {
        console.log("[thumb-eval] early-return dedupe-force-ready", {
          itemId: item.id,
          thumbStatus: item.thumbStatus,
          hasThumb: item.hasThumb,
          force,
        });
        return;
      }

      if (!force && item.thumbStatus === "error") {
        console.log("[thumb-eval] early-return error-status", {
          itemId: item.id,
          thumbStatus: item.thumbStatus,
          force,
        });
        return;
      }

      console.log("[thumb-eval] queue-thumbnail-generation", {
        itemId: item.id,
        vaultKey,
        vaultPath,
        force,
        thumbStatus: item.thumbStatus,
      });
      queueThumbnailGeneration({
        ...item,
        thumbPath,
        width,
        height,
        thumbStatus: "pending",
      });
    },
    [persistItemMediaState, persistThumbStatusForVaultKey, queueThumbnailGeneration],
  );

  const enqueueImageThumbnailEvaluation = useCallback(
    (item: Item, options?: { force?: boolean; retryAttempt?: number }) => {
      if (item.type !== "image" || !item.vaultKey) {
        console.log("[thumb-eval] enqueue-skip-invalid-item", {
          itemId: item.id,
          type: item.type,
          hasVaultKey: Boolean(item.vaultKey),
        });
        return;
      }

      const itemId = item.id;
      const force = options?.force ?? false;
      const retryAttempt = options?.retryAttempt ?? 0;
      const maxRetryAttempts = 3;
      const retryDelayMs = 300;

      if (force) {
        console.log("[thumb-eval] enqueue-force", { itemId });
        imageThumbnailEvaluationRequestedRef.current.delete(itemId);
      }
      if (!force && imageThumbnailEvaluationRequestedRef.current.has(itemId)) {
        console.log("[thumb-eval] early-return dedupe-force-pending", { itemId, force });
        return;
      }

      imageThumbnailEvaluationRequestedRef.current.add(itemId);
      imageEvaluationQueueRef.current.enqueue({
        dedupeKey: itemId,
        run: async () => {
          try {
            const fromRef = itemsRef.current.find((candidate) => candidate.id === itemId);
            const candidate =
              item.type === "image" && item.vaultPath && item.vaultKey
                ? item
                : fromRef ?? item;

            if (
              candidate.type !== "image" ||
              !candidate.vaultPath ||
              !candidate.vaultKey
            ) {
              if (!isUnmountedRef.current && retryAttempt < maxRetryAttempts) {
                const nextRetryAttempt = retryAttempt + 1;
                console.warn("[thumb-eval] missing-vault retry-scheduled", {
                  itemId,
                  retryAttempt: nextRetryAttempt,
                  maxRetryAttempts,
                  retryDelayMs,
                });
                window.setTimeout(() => {
                  if (isUnmountedRef.current) {
                    return;
                  }
                  enqueueImageThumbnailEvaluation(item, {
                    force: true,
                    retryAttempt: nextRetryAttempt,
                  });
                }, retryDelayMs);
              } else {
                console.warn("[thumb-eval] missing-vault retry-exhausted", {
                  itemId,
                  retryAttempt,
                  maxRetryAttempts,
                });
              }
              return;
            }

            await evaluateImageThumbnailStateNow(candidate, { force });
            await yieldToMainThread();
          } finally {
            imageThumbnailEvaluationRequestedRef.current.delete(itemId);
          }
        },
        onError: (error) => {
          console.error("Image thumbnail evaluation failed:", itemId, error);
        },
      });
    },
    [evaluateImageThumbnailStateNow],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((current) => ({ ...current, open: false, itemId: null }));
  }, []);

  const commitPendingUndoableAction = useCallback(async () => {
    const pending = pendingUndoableActionRef.current;
    if (!pending) {
      return false;
    }

    pendingUndoableActionRef.current = null;
    window.clearTimeout(pending.timeoutId);
    setSnackbar((current) => (current?.id === pending.id ? null : current));

    try {
      await pending.commit();
      pending.finalizeUi?.();
      return true;
    } catch (error) {
      console.error("Failed to commit pending undoable action:", error);
      pending.undoUi();
      return false;
    }
  }, []);

  const enqueueUndoableSnackbarAction = useCallback(
    async (args: {
      message: string;
      actionKind: UndoableSnackbarActionKind;
      commit: () => Promise<void>;
      undoUi: () => void;
      finalizeUi?: () => void;
      skipCommitPending?: boolean;
    }) => {
      if (!args.skipCommitPending) {
        await commitPendingUndoableAction();
      }
      if (snackbarInfoTimeoutRef.current !== null) {
        window.clearTimeout(snackbarInfoTimeoutRef.current);
        snackbarInfoTimeoutRef.current = null;
      }

      const id = ++snackbarSequenceRef.current;
      const visibleUntil = Date.now() + UNDO_SNACKBAR_TIMEOUT_MS;
      const timeoutId = window.setTimeout(() => {
        const pending = pendingUndoableActionRef.current;
        if (!pending || pending.id !== id) {
          return;
        }
        void commitPendingUndoableAction();
      }, UNDO_SNACKBAR_TIMEOUT_MS);

      pendingUndoableActionRef.current = {
        id,
        commit: args.commit,
        undoUi: args.undoUi,
        finalizeUi: args.finalizeUi,
        timeoutId,
      };
      setSnackbar({
        id,
        message: args.message,
        actionKind: args.actionKind,
        visibleUntil,
        canUndo: true,
      });
    },
    [commitPendingUndoableAction],
  );

  const showInfoSnackbar = useCallback(
    async (args: {
      message: string;
      actionKind?: UndoableSnackbarActionKind;
      timeoutMs?: number;
      skipCommitPending?: boolean;
    }) => {
      if (!args.skipCommitPending) {
        await commitPendingUndoableAction();
      }
      if (snackbarInfoTimeoutRef.current !== null) {
        window.clearTimeout(snackbarInfoTimeoutRef.current);
        snackbarInfoTimeoutRef.current = null;
      }

      const id = ++snackbarSequenceRef.current;
      const timeoutMs = args.timeoutMs ?? UNDO_SNACKBAR_TIMEOUT_MS;
      const visibleUntil = Date.now() + timeoutMs;
      setSnackbar({
        id,
        message: args.message,
        actionKind: args.actionKind ?? "move",
        visibleUntil,
        canUndo: false,
      });

      snackbarInfoTimeoutRef.current = window.setTimeout(() => {
        setSnackbar((current) => (current?.id === id ? null : current));
        snackbarInfoTimeoutRef.current = null;
      }, timeoutMs);
    },
    [commitPendingUndoableAction],
  );

  const handleUndoSnackbar = useCallback(() => {
    const pending = pendingUndoableActionRef.current;
    if (!pending) {
      setSnackbar(null);
      return;
    }
    pendingUndoableActionRef.current = null;
    window.clearTimeout(pending.timeoutId);
    pending.undoUi();
    setSnackbar((current) => (current?.id === pending.id ? null : current));
  }, []);

  const createTag = useCallback(async (): Promise<Tag | null> => {
    const generatedName = nextTagName(tags);
    try {
      const createdTag = await createTagInDb({
        name: generatedName,
        color: TAG_COLOR_PALETTE[0] ?? DEFAULT_TAG_COLOR,
      });
      setTags((currentTags) => sortTagsByOrder([...currentTags, createdTag]));
      await showInfoSnackbar({ message: `Tag created: ${createdTag.name}` });
      return createdTag;
    } catch (error) {
      console.error("Failed to create tag:", error);
      return null;
    }
  }, [showInfoSnackbar, tags]);

  const renameTag = useCallback(
    async (id: string, nextName: string): Promise<boolean> => {
      const trimmedName = nextName.trim();
      if (trimmedName.length === 0) {
        return false;
      }

      const currentTag = tagById.get(id);
      if (!currentTag) {
        return false;
      }

      if (trimmedName === currentTag.name) {
        return true;
      }

      try {
        const updatedAt = await updateTagNameInDb(id, trimmedName);
        setTags((currentTags) =>
          currentTags.map((tag) =>
            tag.id === id ? { ...tag, name: trimmedName, updatedAt } : tag,
          ),
        );
        setItems((currentItems) =>
          currentItems.map((item) => {
            const tagIndex = item.tagIds.indexOf(id);
            if (tagIndex < 0) return item;
            const nextTags = item.tags.slice();
            nextTags[tagIndex] = trimmedName;
            return { ...item, tags: nextTags };
          }),
        );
        await showInfoSnackbar({ message: `Tag renamed: ${trimmedName}` });
        return true;
      } catch (error) {
        console.error("Failed to rename tag:", error);
        return false;
      }
    },
    [showInfoSnackbar, tagById],
  );

  const duplicateTag = useCallback(
    async (id: string): Promise<Tag | null> => {
      try {
        const duplicated = await duplicateTagInDb(id);
        setTags((currentTags) => sortTagsByOrder([...currentTags, duplicated]));
        await showInfoSnackbar({ message: `Tag duplicated: ${duplicated.name}` });
        return duplicated;
      } catch (error) {
        console.error("Failed to duplicate tag:", error);
        return null;
      }
    },
    [showInfoSnackbar],
  );

  const updateTagColor = useCallback(
    async (id: string, color: string): Promise<boolean> => {
      const currentTag = tagById.get(id);
      if (!currentTag || currentTag.color === color) {
        return false;
      }
      try {
        const updatedAt = await updateTagColorInDb(id, color);
        setTags((currentTags) =>
          currentTags.map((tag) => (tag.id === id ? { ...tag, color, updatedAt } : tag)),
        );
        await showInfoSnackbar({ message: `Tag color updated: ${currentTag.name}` });
        return true;
      } catch (error) {
        console.error("Failed to update tag color:", error);
        return false;
      }
    },
    [showInfoSnackbar, tagById],
  );

  const reorderTags = useCallback(
    async (orderedTagIds: string[]) => {
      const normalizedOrderedIds = Array.from(new Set(orderedTagIds));
      if (normalizedOrderedIds.length < 2) {
        return;
      }

      const currentTags = tags;
      const currentTagIds = currentTags.map((tag) => tag.id);
      if (
        currentTagIds.length !== normalizedOrderedIds.length ||
        currentTagIds.some((id) => !normalizedOrderedIds.includes(id))
      ) {
        return;
      }

      const currentById = new Map(currentTags.map((tag) => [tag.id, tag] as const));
      const optimisticTags = normalizedOrderedIds.map((tagId, index) => {
        const tag = currentById.get(tagId);
        if (!tag) {
          return null;
        }
        return { ...tag, sortIndex: index };
      });
      if (optimisticTags.some((tag) => tag === null)) {
        return;
      }

      const previousTags = currentTags;
      setTags(optimisticTags as Tag[]);

      try {
        const result = await reorderTagsInDb(normalizedOrderedIds);
        setTags((latestTags) =>
          latestTags.map((tag) => ({
            ...tag,
            updatedAt:
              normalizedOrderedIds.includes(tag.id)
                ? result.updatedAt
                : tag.updatedAt,
          })),
        );
      } catch (error) {
        console.error("Failed to reorder tags:", error);
        setTags(previousTags);
      }
    },
    [tags],
  );

  const requestDeleteTag = useCallback(
    (id: string) => {
      const targetTag = tagById.get(id);
      if (!targetTag) {
        return;
      }
      const itemsCount = items.reduce(
        (count, item) => (item.tagIds.includes(id) ? count + 1 : count),
        0,
      );
      setDeleteTagConfirm({
        tagId: id,
        tagName: targetTag.name,
        itemsCount,
      });
    },
    [items, tagById],
  );

  const handleConfirmDeleteTag = useCallback(async () => {
    if (!deleteTagConfirm || isActionInProgress) {
      return;
    }

    setIsActionInProgress(true);
    const { tagId, tagName } = deleteTagConfirm;
    try {
      await deleteTagInDb(tagId);
      setTags((currentTags) => currentTags.filter((tag) => tag.id !== tagId));
      setItems((currentItems) =>
        currentItems.map((item) => {
          const nextTagIds: string[] = [];
          const nextTags: string[] = [];
          item.tagIds.forEach((entryTagId, index) => {
            if (entryTagId === tagId) {
              return;
            }
            nextTagIds.push(entryTagId);
            const tagNameAtIndex = item.tags[index];
            if (typeof tagNameAtIndex === "string") {
              nextTags.push(tagNameAtIndex);
            }
          });
          if (nextTagIds.length === item.tagIds.length) {
            return item;
          }
          return {
            ...item,
            tagIds: nextTagIds,
            tags: nextTags,
          };
        }),
      );
      if (selectedTagId === tagId) {
        setSelectedTagId(null);
      }
      setDeleteTagConfirm(null);
      await showInfoSnackbar({ message: `Tag deleted: ${tagName}` });
    } catch (error) {
      console.error("Failed to delete tag:", error);
    } finally {
      setIsActionInProgress(false);
    }
  }, [deleteTagConfirm, isActionInProgress, selectedTagId, showInfoSnackbar]);

  const updateItemTagIds = useCallback(
    async (itemId: string, nextTagIds: string[]) => {
      const uniqueTagIds = Array.from(new Set(nextTagIds));
      const currentItem = itemsRef.current.find((item) => item.id === itemId);
      if (!currentItem) {
        return;
      }

      const sameTags =
        currentItem.tagIds.length === uniqueTagIds.length &&
        currentItem.tagIds.every((tagId, index) => tagId === uniqueTagIds[index]);
      if (sameTags) {
        return;
      }

      try {
        const updatedAt = await updateItemTagsInDb(itemId, uniqueTagIds);
        setItems((currentItems) =>
          currentItems.map((item) => {
            if (item.id !== itemId) {
              return item;
            }
            const nextTagNames = uniqueTagIds
              .map((tagId) => tagById.get(tagId)?.name)
              .filter((value): value is string => Boolean(value));
            return {
              ...item,
              tagIds: uniqueTagIds,
              tags: nextTagNames,
              updatedAt: formatDateFromTimestampMs(updatedAt),
            };
          }),
        );
      } catch (error) {
        console.error("Failed to update item tags:", error);
      }
    },
    [tagById],
  );

  const updateItemPreferences = useCallback(
    async (
      itemId: string,
      changes: {
        rating?: number;
        isFavorite?: boolean;
      },
    ) => {
      const currentItem = itemsRef.current.find((item) => item.id === itemId);
      if (!currentItem) {
        return;
      }

      const nextRating =
        changes.rating === undefined ? currentItem.rating : normalizeItemRating(changes.rating);
      const nextIsFavorite =
        changes.isFavorite === undefined ? currentItem.isFavorite : Boolean(changes.isFavorite);
      if (nextRating === currentItem.rating && nextIsFavorite === currentItem.isFavorite) {
        return;
      }

      const previousSnapshot = {
        rating: currentItem.rating,
        isFavorite: currentItem.isFavorite,
        updatedAt: currentItem.updatedAt,
      };

      setItems((currentItems) =>
        currentItems.map((item) =>
          item.id === itemId
            ? {
                ...item,
                rating: nextRating,
                isFavorite: nextIsFavorite,
              }
            : item,
        ),
      );

      try {
        const updatedAt = await updateItemPreferencesInDb({
          itemId,
          ...(changes.rating !== undefined ? { rating: nextRating } : {}),
          ...(changes.isFavorite !== undefined ? { isFavorite: nextIsFavorite } : {}),
        });
        setItems((currentItems) =>
          currentItems.map((item) =>
            item.id === itemId
              ? { ...item, updatedAt: formatDateFromTimestampMs(updatedAt) }
              : item,
          ),
        );
      } catch (error) {
        console.error("Failed to update item preferences:", error);
        setItems((currentItems) =>
          currentItems.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  rating: previousSnapshot.rating,
                  isFavorite: previousSnapshot.isFavorite,
                  updatedAt: previousSnapshot.updatedAt,
                }
              : item,
          ),
        );
      }
    },
    [],
  );

  const handleSetItemRating = useCallback(
    (itemId: string, rating: number) => updateItemPreferences(itemId, { rating }),
    [updateItemPreferences],
  );

  const handleToggleItemFavorite = useCallback(
    (itemId: string) => {
      const currentItem = itemsRef.current.find((item) => item.id === itemId);
      if (!currentItem) {
        return;
      }
      return updateItemPreferences(itemId, { isFavorite: !currentItem.isFavorite });
    },
    [updateItemPreferences],
  );

  // QA checklist (ratings/favorites MVP):
  // - Set rating 1..5, click same star again to clear to 0, restart app and verify persistence.
  // - Toggle favorite in Preview, restart app and verify Favorites sidebar view includes/excludes item.
  // - Combine search/tag/collection with each sort option, including Rating high->low.

  const addTagToItem = useCallback(
    async (itemId: string, tagId: string) => {
      const targetItem = itemsRef.current.find((item) => item.id === itemId);
      if (!targetItem || targetItem.tagIds.includes(tagId)) {
        return;
      }
      await updateItemTagIds(itemId, [...targetItem.tagIds, tagId]);
    },
    [updateItemTagIds],
  );

  const normalizeTargetItemIds = useCallback((itemIds: string[]): string[] => {
    const deduped = Array.from(new Set(itemIds));
    if (deduped.length === 0) return [];
    return deduped;
  }, []);

  const requestDeleteItems = useCallback(
    (itemIds: string[]) => {
      const targetIds = normalizeTargetItemIds(itemIds);
      if (targetIds.length === 0) return;
      setDeleteConfirmItemIds(targetIds);
    },
    [normalizeTargetItemIds],
  );

  const performDeleteItems = useCallback(
    async (itemIds: string[]) => {
      const idsToDelete = new Set(itemIds);
      if (idsToDelete.size === 0) return;

      const removedItems = itemsRef.current.filter((item) => idsToDelete.has(item.id));
      if (removedItems.length === 0) return;

      const removedItemsById = new Map(removedItems.map((item) => [item.id, item] as const));
      const previousSelectedIds = [...selectedIds];
      const previousSelectionAnchorId = selectionAnchorId;
      const previousDescriptionPersistRequest = descriptionPersistRequest
        ? { ...descriptionPersistRequest }
        : null;

      await commitPendingUndoableAction();

      setItems((currentItems) => currentItems.filter((item) => !idsToDelete.has(item.id)));
      setSelectedIds((currentSelectedIds) =>
        currentSelectedIds.filter((itemId) => !idsToDelete.has(itemId)),
      );
      setSelectionAnchorId((currentAnchorId) =>
        currentAnchorId !== null && idsToDelete.has(currentAnchorId) ? null : currentAnchorId,
      );
      setDescriptionPersistRequest((current) =>
        current && idsToDelete.has(current.itemId) ? null : current,
      );

      const count = removedItems.length;
      await enqueueUndoableSnackbarAction({
        actionKind: "delete",
        message: count === 1 ? "Deleted 1 item" : `Deleted ${count} items`,
        skipCommitPending: true,
        commit: async () => {
          setIsActionInProgress(true);
          try {
            console.log("Delete action requested:", Array.from(idsToDelete));
            const deleteResult = await deleteItemsByIdsWithCleanupInDb(Array.from(idsToDelete));
            console.log("Delete action rows removed:", deleteResult.deletedRows);
            deleteResult.cleanup.forEach((entry) => {
              console.log(
                "Vault cleanup:",
                entry.vaultKey,
                entry.deletedFromDisk ? "deleted" : "deferred-or-missing",
              );
            });
          } finally {
            setIsActionInProgress(false);
          }
        },
        undoUi: () => {
          setItems((currentItems) => {
            const existingIds = new Set(currentItems.map((item) => item.id));
            const restoredItems = removedItems.filter((item) => !existingIds.has(item.id));
            return restoredItems.length > 0 ? [...restoredItems, ...currentItems] : currentItems;
          });
          setSelectedIds(previousSelectedIds);
          setSelectionAnchorId(previousSelectionAnchorId);
          setDescriptionPersistRequest(previousDescriptionPersistRequest);
        },
        finalizeUi: () => {
          removedItemsById.forEach((item) => {
            releaseTransientPreviewUrl(item.id);
            descriptionDraftByItemIdRef.current.delete(item.id);
          });
        },
      });
    },
    [
      selectedIds,
      selectionAnchorId,
      descriptionPersistRequest,
      releaseTransientPreviewUrl,
      enqueueUndoableSnackbarAction,
      commitPendingUndoableAction,
    ],
  );

  const duplicateItemsById = useCallback(
    async (
      itemIds: string[],
      options?: {
        targetCollectionId?: string | null;
        closeContextMenu?: boolean;
      },
    ): Promise<Item[] | null> => {
      const targetIds = new Set(normalizeTargetItemIds(itemIds));
      if (targetIds.size === 0) return null;
      const sourceItems = itemsRef.current.filter((item) => targetIds.has(item.id));
      if (sourceItems.length === 0) return null;

      setIsActionInProgress(true);
      const duplicatedItems: Item[] = [];
      try {
        for (const [index, sourceItem] of sourceItems.entries()) {
          const duplicatedId = createItemId();
          const timestampMs = Date.now() + index;
          const selectedContextCollectionId =
            selectedCollectionId &&
            sourceItem.collectionIds.includes(selectedCollectionId)
              ? selectedCollectionId
              : null;
          const preferredTargetCollectionId =
            options?.targetCollectionId &&
            sourceItem.collectionIds.includes(options.targetCollectionId)
              ? options.targetCollectionId
              : null;
          const primaryCollectionId =
            preferredTargetCollectionId ?? selectedContextCollectionId ?? sourceItem.collectionId;
          const duplicatedCollectionInstancesByCollectionId =
            primaryCollectionId !== null &&
            sourceItem.collectionInstancesByCollectionId[primaryCollectionId]
              ? {
                  [primaryCollectionId]: {
                    ...sourceItem.collectionInstancesByCollectionId[primaryCollectionId],
                    instanceId: createCollectionMembershipInstanceId(),
                    collectionId: primaryCollectionId,
                    sortIndex: timestampMs,
                    createdAt: timestampMs,
                  },
                }
              : {};
          const duplicatedItem: Item = {
            ...sourceItem,
            id: duplicatedId,
            createdAt: formatDateFromTimestampMs(timestampMs),
            updatedAt: formatDateFromTimestampMs(timestampMs),
            collectionId: primaryCollectionId,
            collectionIds: primaryCollectionId ? [primaryCollectionId] : [],
            collectionInstancesByCollectionId: duplicatedCollectionInstancesByCollectionId,
            collectionPath:
              primaryCollectionId !== null
                ? collectionPathById.get(primaryCollectionId) ?? "All Items"
                : "All Items",
          };

          await insertItemInDb(
            toDbInsertItem({
              item: duplicatedItem,
              createdAtMs: timestampMs,
              updatedAtMs: timestampMs,
            }),
          );
          duplicatedItems.push(duplicatedItem);
        }
      } catch (error) {
        console.error("Failed to duplicate selected items:", error);
        return null;
      } finally {
        setIsActionInProgress(false);
      }

      if (duplicatedItems.length === 0) return null;
      console.log("Duplicate action created item ids:", duplicatedItems.map((item) => item.id));
      setItems((currentItems) => [...duplicatedItems, ...currentItems]);
      setSelectedIds(duplicatedItems.map((item) => item.id));
      setSelectionAnchorId(duplicatedItems[duplicatedItems.length - 1]?.id ?? null);
      void showInfoSnackbar({
        actionKind: "duplicate",
        message:
          duplicatedItems.length === 1
            ? "Duplicated 1 item"
            : `Duplicated ${duplicatedItems.length} items`,
      });
      if (options?.closeContextMenu !== false) {
        closeContextMenu();
      }
      return duplicatedItems;
    },
    [normalizeTargetItemIds, collectionPathById, showInfoSnackbar, closeContextMenu, selectedCollectionId],
  );

  const applyCollectionMembershipTransfer = useCallback(
    async (params: {
      itemIds: string[];
      sourceCollectionId: string | null;
      targetCollectionId: string | null;
      mode: "move" | "duplicate";
    }): Promise<boolean> => {
      const normalizedTargetIds = normalizeTargetItemIds(params.itemIds);
      if (normalizedTargetIds.length === 0) {
        return false;
      }

      if (
        params.mode === "move" &&
        params.sourceCollectionId !== null &&
        params.sourceCollectionId === params.targetCollectionId
      ) {
        return false;
      }

      if (params.mode === "duplicate" && params.targetCollectionId === null) {
        return false;
      }

      const targetIdSet = new Set(normalizedTargetIds);
      const currentItems = itemsRef.current;
      const optimisticUpdatedAt = formatDateFromTimestampMs(Date.now());
      const nextItemById = new Map<string, Item>();
      const snapshotsByItemId = new Map<string, ItemMembershipUiSnapshot>();

      currentItems.forEach((item) => {
        if (!targetIdSet.has(item.id)) {
          return;
        }

        const nextItem =
          params.mode === "duplicate" && params.targetCollectionId !== null
            ? addCollectionMembershipToItem({
                item,
                collectionId: params.targetCollectionId,
                collectionPathById,
                preservePrimary: true,
                updatedAt: optimisticUpdatedAt,
              })
            : moveCollectionMembershipOnItem({
                item,
                sourceCollectionId: params.sourceCollectionId,
                targetCollectionId: params.targetCollectionId,
                collectionPathById,
                updatedAt: optimisticUpdatedAt,
              });

        if (nextItem === item) {
          return;
        }

        snapshotsByItemId.set(item.id, createItemMembershipSnapshot(item));
        nextItemById.set(item.id, nextItem);
      });

      if (nextItemById.size === 0) {
        return false;
      }

      const changedItemIds = Array.from(nextItemById.keys());
      const changedCount = changedItemIds.length;
      const changedItemIdSet = new Set(changedItemIds);
      const targetCollectionName =
        params.targetCollectionId !== null
          ? collections.find((collection) => collection.id === params.targetCollectionId)?.name ??
            "Collection"
          : null;
      const sourceCollectionName =
        params.sourceCollectionId !== null
          ? collections.find((collection) => collection.id === params.sourceCollectionId)?.name ??
            "Collection"
          : null;

      const actionKind: UndoableSnackbarActionKind =
        params.mode === "duplicate"
          ? "duplicate"
          : params.targetCollectionId === null
            ? "remove"
            : "move";
      const message =
        params.mode === "duplicate"
          ? changedCount === 1
            ? `Added 1 item to "${targetCollectionName}"`
            : `Added ${changedCount} items to "${targetCollectionName}"`
          : params.targetCollectionId === null
            ? changedCount === 1
              ? `Removed 1 item from "${sourceCollectionName ?? "Collection"}"`
              : `Removed ${changedCount} items from "${sourceCollectionName ?? "Collection"}"`
            : changedCount === 1
              ? `Moved 1 item to "${targetCollectionName}"`
              : `Moved ${changedCount} items to "${targetCollectionName}"`;

      const moveUndoAddBackToSourceIds: string[] = [];
      const moveUndoMoveBackIds: string[] = [];
      const moveUndoRemoveFromTargetIds: string[] = [];
      const duplicateUndoRemoveFromTargetIds: string[] = [];

      if (params.mode === "duplicate" && params.targetCollectionId !== null) {
        currentItems.forEach((item) => {
          if (changedItemIdSet.has(item.id)) {
            duplicateUndoRemoveFromTargetIds.push(item.id);
          }
        });
      } else {
        currentItems.forEach((item) => {
          if (!changedItemIdSet.has(item.id)) return;
          const hadSource =
            params.sourceCollectionId !== null &&
            item.collectionIds.includes(params.sourceCollectionId);
          const hadTarget =
            params.targetCollectionId !== null &&
            item.collectionIds.includes(params.targetCollectionId);

          if (params.sourceCollectionId === null && params.targetCollectionId !== null) {
            moveUndoRemoveFromTargetIds.push(item.id);
            return;
          }

          if (params.targetCollectionId === null && params.sourceCollectionId !== null) {
            moveUndoAddBackToSourceIds.push(item.id);
            return;
          }

          if (params.sourceCollectionId !== null && params.targetCollectionId !== null) {
            if (hadTarget) {
              // Move collapsed an existing duplicate target membership by removing the source membership.
              moveUndoAddBackToSourceIds.push(item.id);
            } else if (hadSource) {
              moveUndoMoveBackIds.push(item.id);
            }
          }
        });
      }

      await commitPendingUndoableAction();

      setItems((itemsState) =>
        itemsState.map((item) => nextItemById.get(item.id) ?? item),
      );

      setIsActionInProgress(true);
      try {
        if (params.mode === "duplicate" && params.targetCollectionId !== null) {
          await addItemsToCollectionInDb(changedItemIds, params.targetCollectionId);
        } else {
          await moveCollectionItemMembershipsInDb({
            itemIds: changedItemIds,
            sourceCollectionId: params.sourceCollectionId,
            targetCollectionId: params.targetCollectionId,
          });
        }
        await reloadItemsFromDb();
      } catch (error) {
        console.error("Failed to update collection memberships:", error);
        setItems((itemsState) =>
          itemsState.map((item) => {
            const snapshot = snapshotsByItemId.get(item.id);
            return snapshot ? restoreItemMembershipSnapshot(item, snapshot) : item;
          }),
        );
        return false;
      } finally {
        setIsActionInProgress(false);
      }

      await enqueueUndoableSnackbarAction({
        message,
        actionKind,
        skipCommitPending: true,
        commit: async () => {},
        undoUi: () => {
          setItems((itemsState) =>
            itemsState.map((item) => {
              const snapshot = snapshotsByItemId.get(item.id);
              return snapshot ? restoreItemMembershipSnapshot(item, snapshot) : item;
            }),
          );

          void (async () => {
            setIsActionInProgress(true);
            try {
              if (
                params.mode === "duplicate" &&
                params.targetCollectionId !== null &&
                duplicateUndoRemoveFromTargetIds.length > 0
              ) {
                await moveCollectionItemMembershipsInDb({
                  itemIds: duplicateUndoRemoveFromTargetIds,
                  sourceCollectionId: params.targetCollectionId,
                  targetCollectionId: null,
                });
              } else {
                if (
                  params.targetCollectionId !== null &&
                  params.sourceCollectionId !== null &&
                  moveUndoMoveBackIds.length > 0
                ) {
                  await moveCollectionItemMembershipsInDb({
                    itemIds: moveUndoMoveBackIds,
                    sourceCollectionId: params.targetCollectionId,
                    targetCollectionId: params.sourceCollectionId,
                  });
                }
                if (params.sourceCollectionId !== null && moveUndoAddBackToSourceIds.length > 0) {
                  await addItemsToCollectionInDb(moveUndoAddBackToSourceIds, params.sourceCollectionId);
                }
                if (
                  params.targetCollectionId !== null &&
                  moveUndoRemoveFromTargetIds.length > 0
                ) {
                  await moveCollectionItemMembershipsInDb({
                    itemIds: moveUndoRemoveFromTargetIds,
                    sourceCollectionId: params.targetCollectionId,
                    targetCollectionId: null,
                  });
                }
              }
              await reloadItemsFromDb();
            } catch (error) {
              console.error("Failed to undo collection membership transfer:", error);
              void reloadItemsFromDb().catch((reloadError) => {
                console.error("Failed to reload items after undo error:", reloadError);
              });
            } finally {
              setIsActionInProgress(false);
            }
          })();
        },
      });

      return true;
    },
    [
      normalizeTargetItemIds,
      collectionPathById,
      collections,
      commitPendingUndoableAction,
      enqueueUndoableSnackbarAction,
      reloadItemsFromDb,
    ],
  );

  const handleCollectionMembershipDrop = useCallback(
    async (args: {
      itemIds: string[];
      sourceCollectionId: string | null;
      targetCollectionId: string;
      op: "move" | "duplicate";
    }) => {
      console.log("[dnd][drop][handle]", args);
      await applyCollectionMembershipTransfer({
        itemIds: args.itemIds,
        sourceCollectionId: args.sourceCollectionId,
        targetCollectionId: args.targetCollectionId,
        mode: args.op,
      });
    },
    [applyCollectionMembershipTransfer],
  );

  const requestMoveItems = useCallback(
    (itemIds: string[]) => {
      const targetIds = normalizeTargetItemIds(itemIds);
      if (targetIds.length === 0) return;
      setMoveTargetItemIds(targetIds);
    },
    [normalizeTargetItemIds],
  );

  const moveSelectedItemsToCollection = useCallback(
    async (collectionId: string | null) => {
      const targetIds = normalizeTargetItemIds(moveTargetItemIds);
      if (targetIds.length === 0) return;

      const moved = await applyCollectionMembershipTransfer({
        itemIds: targetIds,
        sourceCollectionId: selectedCollectionId,
        targetCollectionId: collectionId,
        mode: "move",
      });
      if (!moved) {
        setMoveTargetItemIds([]);
        return;
      }
      setMoveTargetItemIds([]);
      closeContextMenu();
    },
    [
      moveTargetItemIds,
      normalizeTargetItemIds,
      applyCollectionMembershipTransfer,
      selectedCollectionId,
      closeContextMenu,
    ],
  );

  const markImportAsError = useCallback((itemId: string, error: unknown) => {
    console.error("Import job failed:", itemId, error);
    releaseTransientPreviewUrl(itemId);
    void markItemImportErrorInDb(itemId).catch((dbError) => {
      console.error("Failed to persist import error state:", itemId, dbError);
    });
    setItems((currentItems) =>
      currentItems.map((item) =>
        item.id === itemId
          ? {
              ...item,
              status: "error",
              importStatus: "error",
              description: "Import failed.",
              hasThumb: item.type === "image" ? false : item.hasThumb,
              thumbStatus: item.type === "image" ? "error" : item.thumbStatus,
            }
          : item,
      ),
    );
  }, [releaseTransientPreviewUrl]);

  const finalizeImportForItem = useCallback(
    async (itemId: string, itemType: ItemType, imported: ImportPipelineResult) => {
      const vaultKey = buildVaultKey(imported.sha256, imported.ext);
      const updatedAtMs = await finalizeItemImportInDb({
        itemId,
        title: fileTitleFromFilename(imported.originalFilename),
        filename: imported.originalFilename,
        vaultKey,
        vaultPath: imported.vaultPath,
        width: imported.width,
        height: imported.height,
        thumbStatus: imported.thumbStatus,
      });

      if (isUnmountedRef.current) {
        return;
      }

      releaseTransientPreviewUrl(itemId);
      const currentItem = itemsRef.current.find((candidate) => candidate.id === itemId) ?? null;
      const finalizedEnqueueItem =
        currentItem && currentItem.type === "image"
          ? {
              ...applyImportResultToItem({
                item: currentItem,
                imported,
                itemType: currentItem.type,
              }),
              updatedAt: formatDateFromTimestampMs(updatedAtMs),
            }
          : null;
      let finalizedImageItem: Item | null = null;
      setItems((currentItems) =>
        currentItems.map((item) => {
          if (item.id !== itemId) {
            return item;
          }
          const finalized = applyImportResultToItem({
            item,
            imported,
            itemType,
          });
          const nextItem = {
            ...finalized,
            updatedAt: formatDateFromTimestampMs(updatedAtMs),
          };
          if (nextItem.type === "image") {
            finalizedImageItem = nextItem;
          }
          return nextItem;
        }),
      );
      const latestFinalizedItem =
        finalizedImageItem ??
        finalizedEnqueueItem ??
        itemsRef.current.find((candidate) => candidate.id === itemId) ??
        null;
      if (
        latestFinalizedItem?.type === "image" &&
        latestFinalizedItem.vaultPath &&
        latestFinalizedItem.vaultKey &&
        latestFinalizedItem.thumbStatus !== "skipped" &&
        !latestFinalizedItem.hasThumb
      ) {
        console.log("ENQUEUE THUMB", latestFinalizedItem.id);
        queueThumbnailGeneration(latestFinalizedItem);
      }

      console.log("[import-pipeline] finish", {
        itemId,
        hashMs: imported.metrics.hashMs,
        copyMs: imported.metrics.copyMs,
        metadataMs: imported.metrics.metadataMs,
        thumbMs: imported.metrics.thumbMs,
        totalMs: imported.metrics.totalMs,
        deduped: imported.metrics.deduped,
        thumbStatus: imported.thumbStatus,
      });
    },
    [queueThumbnailGeneration, releaseTransientPreviewUrl],
  );

  const enqueueImportJob = useCallback(
    (itemId: string) => {
      importQueueRef.current.enqueue({
        dedupeKey: itemId,
        run: async () => {
          const source = importSourceByItemIdRef.current.get(itemId);
          if (!source) {
            throw new Error(`Import source missing for item ${itemId}`);
          }

          try {
            let imported: ImportPipelineResult;
            if (source.kind === "path") {
              imported = await processImportPathJob({
                originalPath: source.originalPath,
                generateThumb: false,
              });
            } else {
              let bytes: Uint8Array;
              if (source.kind === "file") {
                const maybePath = (source.file as File & { path?: string }).path;
                if (typeof maybePath === "string" && maybePath.trim().length > 0) {
                  imported = await processImportPathJob({
                    originalPath: maybePath,
                    generateThumb: false,
                  });
                  await finalizeImportForItem(itemId, source.type, imported);
                  return;
                }
                bytes = new Uint8Array(await source.file.arrayBuffer());
              } else {
                bytes = source.bytes;
              }

              imported = await processImportBytesJob({
                bytes,
                originalFilename: source.filename,
                ext: source.kind === "file" ? fileFormatFromFilename(source.filename) : source.ext,
                generateThumb: false,
              });
            }

            await finalizeImportForItem(itemId, source.type, imported);
          } catch (error) {
            markImportAsError(itemId, error);
          } finally {
            importSourceByItemIdRef.current.delete(itemId);
            await yieldToMainThread();
          }
        },
        onError: (error) => {
          importSourceByItemIdRef.current.delete(itemId);
          console.error("Import queue job crashed:", itemId, error);
        },
      });
    },
    [finalizeImportForItem, markImportAsError],
  );

  const queueImportSources = useCallback(
    async (sources: ImportSource[]) => {
      if (sources.length === 0) return;

      const placeholders = sources.map((source) => {
        const previewUrl = previewUrlFromImportSource(source);
        return createImportPlaceholderItem({
          filename: source.filename,
          type: source.type,
          collectionId: selectedCollectionId,
          collectionPath: selectedCollectionPath,
          previewUrl,
        });
      });

      const baseTimestamp = Date.now();
      try {
        await insertItemsInDb(
          placeholders.map((item, index) =>
            toDbInsertItem({
              item,
              createdAtMs: baseTimestamp + index,
              updatedAtMs: baseTimestamp + index,
            }),
          ),
        );
      } catch (error) {
        placeholders.forEach((item) => {
          if (item.previewUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(item.previewUrl);
          }
        });
        console.error("Failed to insert import placeholders:", error);
        return;
      }

      if (isUnmountedRef.current) {
        placeholders.forEach((item) => {
          if (item.previewUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(item.previewUrl);
          }
        });
        return;
      }

      setItems((currentItems) => [...placeholders, ...currentItems]);
      const placeholderIds = placeholders.map((item) => item.id);
      setSelectedIds(placeholderIds);
      setSelectionAnchorId(placeholderIds[placeholderIds.length - 1] ?? null);
      await yieldToMainThread();

      if (isUnmountedRef.current) {
        return;
      }

      placeholders.forEach((item, index) => {
        const source = sources[index];
        if (!source) return;
        if (source.type === "image" && item.previewUrl) {
          transientPreviewUrlByItemIdRef.current.set(item.id, item.previewUrl);
        }
        importSourceByItemIdRef.current.set(item.id, source);
        enqueueImportJob(item.id);
      });
    },
    [selectedCollectionId, selectedCollectionPath, enqueueImportJob],
  );

  const importPathsToVault = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const sources: ImportSource[] = paths.map((path) => ({
        kind: "path",
        originalPath: path,
        filename: filenameFromPath(path),
        type: inferType(path),
      }));
      await queueImportSources(sources);
    },
    [queueImportSources],
  );

  const importFileObjectsToVault = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const sources: ImportSource[] = files.map((file) => {
        const maybePath = (file as File & { path?: string }).path;
        if (typeof maybePath === "string" && maybePath.trim().length > 0) {
          return {
            kind: "path",
            originalPath: maybePath,
            filename: file.name || filenameFromPath(maybePath),
            type: inferType(file.name || maybePath, file.type),
          };
        }
        return {
          kind: "file",
          file,
          filename: file.name || "imported-file",
          type: inferType(file.name, file.type),
        };
      });
      await queueImportSources(sources);
    },
    [queueImportSources],
  );

  useEffect(() => {
    let isMounted = true;

    const initializePersistence = async () => {
      try {
        const [storageRoot, thumbsRoot, dbFilePath] = await Promise.all([
          ensureStorageRoot(),
          ensureThumbsRoot(),
          initDb(),
        ]);
        thumbsRootRef.current = thumbsRoot;
        console.log("Vault storage root ready:", storageRoot);
        console.log("Thumbnail root ready:", thumbsRoot);
        console.log("SQLite database ready:", dbFilePath);

        const [persistedState, loadedCollections] = await Promise.all([
          loadDbAppState(),
          getAllCollectionsInDb(),
        ]);
        if (!isMounted) return;

        const collectionRows = loadedCollections;
        const pathById = buildCollectionPathMap(collectionRows);
        const collectionItemsByItemId = buildCollectionItemsByItemId(
          persistedState.collectionItems ?? [],
        );
        const mappedItems = persistedState.items.map((item) =>
          mapDbItemToItem({
            item,
            collectionItemsByItemId,
            collectionPathById: pathById,
            thumbsRoot,
          }),
        );
        const thumbAvailabilityEntries = await Promise.all(
          mappedItems.map(async (mappedItem) => {
            if (mappedItem.type !== "image" || !mappedItem.thumbPath) {
              return [mappedItem.id, false] as const;
            }
            try {
              const hasThumb = await fileExists(mappedItem.thumbPath);
              return [mappedItem.id, hasThumb] as const;
            } catch (error) {
              console.warn("Failed to check thumbnail path:", mappedItem.thumbPath, error);
              return [mappedItem.id, false] as const;
            }
          }),
        );
        if (!isMounted) return;

        const hasThumbByItemId = new Map(thumbAvailabilityEntries);
        const loadedItems = mappedItems.map((mappedItem) => {
          if (mappedItem.type !== "image") {
            return mappedItem;
          }

          const hasThumb = hasThumbByItemId.get(mappedItem.id) ?? false;
          const thumbStatus: ThumbStatus =
            mappedItem.thumbStatus === "skipped"
              ? "skipped"
              : hasThumb
                ? "ready"
                : mappedItem.thumbStatus === "error"
                  ? "error"
                  : "error";

          return {
            ...mappedItem,
            hasThumb,
            thumbStatus,
            thumbUrl:
              hasThumb && mappedItem.thumbPath
                ? previewUrlFromVaultPath(mappedItem.thumbPath)
                : undefined,
          };
        });

        setCollections(collectionRows);
        setTags(persistedState.tags ?? []);
        setItems(loadedItems);
      } catch (error) {
        console.error("Failed to initialize sqlite persistence:", error);
      }
    };

    void initializePersistence();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    isUnmountedRef.current = false;
    thumbnailQueueRef.current = new ThumbnailQueue(THUMB_CONCURRENCY, THUMB_QUEUE_START_DELAY_MS);
    importQueueRef.current = new DedupeAsyncQueue(IMPORT_QUEUE_CONCURRENCY);
    bookmarkMetaQueueRef.current = new DedupeAsyncQueue(BOOKMARK_META_QUEUE_CONCURRENCY);
    importSourceByItemIdRef.current.clear();
    transientPreviewUrlByItemIdRef.current.clear();
    imageEvaluationQueueRef.current = new DedupeAsyncQueue(1);
    imageThumbnailEvaluationRequestedRef.current.clear();
    return () => {
      isUnmountedRef.current = true;
      transientPreviewUrlByItemIdRef.current.forEach((previewUrl) => {
        if (previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(previewUrl);
        }
      });
      transientPreviewUrlByItemIdRef.current.clear();
      thumbnailQueueRef.current.dispose();
      importQueueRef.current.dispose();
      bookmarkMetaQueueRef.current.dispose();
      importSourceByItemIdRef.current.clear();
      imageEvaluationQueueRef.current.dispose();
      imageThumbnailEvaluationRequestedRef.current.clear();
      if (pendingUndoableActionRef.current) {
        window.clearTimeout(pendingUndoableActionRef.current.timeoutId);
        pendingUndoableActionRef.current = null;
      }
      if (snackbarInfoTimeoutRef.current !== null) {
        window.clearTimeout(snackbarInfoTimeoutRef.current);
        snackbarInfoTimeoutRef.current = null;
      }
      if (userInteractionTimeoutRef.current !== null) {
        window.clearTimeout(userInteractionTimeoutRef.current);
        userInteractionTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const markUserInteracting = () => {
      if (!isUserInteractingRef.current) {
        isUserInteractingRef.current = true;
        thumbnailQueueRef.current.setConcurrency(1);
      }

      if (userInteractionTimeoutRef.current !== null) {
        window.clearTimeout(userInteractionTimeoutRef.current);
      }

      userInteractionTimeoutRef.current = window.setTimeout(() => {
        userInteractionTimeoutRef.current = null;
        isUserInteractingRef.current = false;
        thumbnailQueueRef.current.setConcurrency(THUMB_CONCURRENCY);
      }, USER_INTERACTION_IDLE_MS);
    };

    const passiveCaptureOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener("scroll", markUserInteracting, passiveCaptureOptions);
    window.addEventListener("wheel", markUserInteracting, passiveCaptureOptions);
    window.addEventListener("pointerdown", markUserInteracting, passiveCaptureOptions);
    window.addEventListener("keydown", markUserInteracting, true);
    window.addEventListener("dragover", markUserInteracting, true);

    return () => {
      window.removeEventListener("scroll", markUserInteracting, true);
      window.removeEventListener("wheel", markUserInteracting, true);
      window.removeEventListener("pointerdown", markUserInteracting, true);
      window.removeEventListener("keydown", markUserInteracting, true);
      window.removeEventListener("dragover", markUserInteracting, true);
      if (userInteractionTimeoutRef.current !== null) {
        window.clearTimeout(userInteractionTimeoutRef.current);
        userInteractionTimeoutRef.current = null;
      }
      isUserInteractingRef.current = false;
      thumbnailQueueRef.current.setConcurrency(THUMB_CONCURRENCY);
    };
  }, []);

  useEffect(() => {
    const preventWindowDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowDrop);
    window.addEventListener("drop", preventWindowDrop);

    return () => {
      window.removeEventListener("dragover", preventWindowDrop);
      window.removeEventListener("drop", preventWindowDrop);
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      if (deleteCollectionConfirm) {
        setDeleteCollectionConfirm(null);
        return;
      }

      if (deleteConfirmItemIds.length > 0) {
        setDeleteConfirmItemIds([]);
        return;
      }

      if (moveTargetItemIds.length > 0) {
        setMoveTargetItemIds([]);
        return;
      }

      if (imageModalOpen) {
        setImageModalOpen(false);
        setImageModalItemId(null);
        return;
      }

      if (contextMenu.open) {
        closeContextMenu();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    imageModalOpen,
    deleteCollectionConfirm,
    deleteConfirmItemIds.length,
    moveTargetItemIds.length,
    contextMenu.open,
    closeContextMenu,
  ]);

  useEffect(() => {
    if (!deleteCollectionConfirm) return;

    const handleEnterToConfirmCollectionDelete = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (isEditableTarget(event.target)) return;
      if (isActionInProgress) return;
      event.preventDefault();
      void performDeleteCollection();
    };

    window.addEventListener("keydown", handleEnterToConfirmCollectionDelete);
    return () =>
      window.removeEventListener("keydown", handleEnterToConfirmCollectionDelete);
  }, [deleteCollectionConfirm, isActionInProgress, performDeleteCollection]);

  useEffect(() => {
    if (!contextMenu.open) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(event.target as Node)
      ) {
        closeContextMenu();
      }
    };

    const handleScroll = () => {
      closeContextMenu();
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [contextMenu.open, closeContextMenu]);

  useEffect(() => {
    let isCancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          if (isCancelled) return;

          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setNativeDropEnabled(true);
            return;
          }

          if (payload.type === "leave") {
            setNativeDropEnabled(false);
            return;
          }

          if (payload.type === "drop") {
            setNativeDropEnabled(true);
            void (async () => {
              try {
                const droppedPaths = payload.paths.filter((path) => path.trim().length > 0);
                if (droppedPaths.length === 0) return;
                await importPathsToVault(droppedPaths);
              } catch (error) {
                console.error("Native file drop import failed:", error);
              } finally {
                setNativeDropEnabled(false);
              }
            })();
          }
        });
        console.info("[dnd] Native Tauri file drag-drop listener enabled.");
      } catch (error) {
        console.warn("Native Tauri file drag-drop listener unavailable; using DOM drop fallback:", error);
        setNativeDropEnabled(false);
      }
    })();

    return () => {
      isCancelled = true;
      setNativeDropEnabled(false);
      if (unlisten) {
        unlisten();
      }
    };
  }, [importPathsToVault]);

  useEffect(() => {
    const handleDeleteKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete") return;
      if (selectedIds.length === 0) return;
      if (isEditableTarget(event.target)) return;
      if (imageModalOpen || deleteConfirmItemIds.length > 0 || moveTargetItemIds.length > 0) {
        return;
      }

      event.preventDefault();
      requestDeleteItems(selectedIds);
      closeContextMenu();
    };

    window.addEventListener("keydown", handleDeleteKey);
    return () => window.removeEventListener("keydown", handleDeleteKey);
  }, [
    selectedIds,
    imageModalOpen,
    deleteConfirmItemIds.length,
    moveTargetItemIds.length,
    requestDeleteItems,
    closeContextMenu,
  ]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;

      const clipboardItems = Array.from(event.clipboardData?.items ?? []);
      const hasImageItem = clipboardItems.some((item) => item.type.startsWith("image/"));
      const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
      const normalizedUrl = hasImageItem ? null : normalizeHttpUrlInput(clipboardText);
      if (!hasImageItem && !normalizedUrl) {
        return;
      }
      event.preventDefault();

      void (async () => {
        try {
          if (hasImageItem) {
            const pngBytes = await readClipboardImageAsPngBytesFromPasteEvent(event);
            if (!pngBytes) {
              return;
            }
            await queueImportSources([
              {
                kind: "bytes",
                bytes: pngBytes,
                filename: `clipboard-${Date.now()}.png`,
                type: "image",
                ext: "png",
              },
            ]);
            return;
          }

          if (normalizedUrl) {
            await queueBookmarkUrls([normalizedUrl]);
          }
        } catch (error) {
          console.warn("Clipboard paste import failed:", error);
        }
      })();
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [queueImportSources, queueBookmarkUrls]);

  const collectionScopedItems = useMemo(() => {
    if (!selectedCollectionId) {
      return items;
    }
    return items
      .filter((item) => item.collectionIds.includes(selectedCollectionId))
      .slice()
      .sort((left, right) => {
        const leftMembership = left.collectionInstancesByCollectionId[selectedCollectionId];
        const rightMembership = right.collectionInstancesByCollectionId[selectedCollectionId];
        const leftSortKey =
          leftMembership?.sortIndex ?? leftMembership?.createdAt ?? Number.MAX_SAFE_INTEGER;
        const rightSortKey =
          rightMembership?.sortIndex ?? rightMembership?.createdAt ?? Number.MAX_SAFE_INTEGER;
        if (leftSortKey !== rightSortKey) {
          return leftSortKey - rightSortKey;
        }
        const leftCreatedAt = leftMembership?.createdAt ?? 0;
        const rightCreatedAt = rightMembership?.createdAt ?? 0;
        if (leftCreatedAt !== rightCreatedAt) {
          return leftCreatedAt - rightCreatedAt;
        }
        return left.id.localeCompare(right.id);
      });
  }, [items, selectedCollectionId]);

  const viewScopedItems = useMemo(() => {
    if (libraryViewMode !== "favorites") {
      return collectionScopedItems;
    }
    return collectionScopedItems.filter((item) => item.isFavorite);
  }, [collectionScopedItems, libraryViewMode]);

  const tagFilteredItems = useMemo(() => {
    if (!selectedTagId) {
      return viewScopedItems;
    }
    return viewScopedItems.filter((item) => item.tagIds.includes(selectedTagId));
  }, [viewScopedItems, selectedTagId]);

  const filteredItems = useMemo(() => {
    return filterItems({
      items: tagFilteredItems,
      searchQuery: deferredSearchQuery,
      filters: advancedFilters,
      sortOption,
    });
  }, [advancedFilters, deferredSearchQuery, sortOption, tagFilteredItems]);

  const selectedItem =
    selectedIds.length === 1
      ? (() => {
          const foundItem = items.find((item) => item.id === selectedIds[0]) ?? null;
          if (
            !foundItem ||
            selectedCollectionId === null ||
            !foundItem.collectionIds.includes(selectedCollectionId)
          ) {
            return foundItem;
          }
          return {
            ...foundItem,
            collectionPath: collectionPathById.get(selectedCollectionId) ?? foundItem.collectionPath,
          };
        })()
      : null;

  const modalItem =
    imageModalItemId !== null
      ? items.find((item) => item.id === imageModalItemId) ?? null
      : null;
  const contextMenuItem =
    contextMenu.itemId !== null
      ? items.find((item) => item.id === contextMenu.itemId) ?? null
      : null;

  const handleSelectItem = (itemId: string, event: React.MouseEvent) => {
    if (Date.now() < suppressNextItemClickRef.current) {
      suppressNextItemClickRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const filteredIds = filteredItems.map((item) => item.id);
    const isToggle = event.ctrlKey || event.metaKey;

    if (event.shiftKey && selectionAnchorId) {
      const anchorIndex = filteredIds.indexOf(selectionAnchorId);
      const currentIndex = filteredIds.indexOf(itemId);
      if (anchorIndex !== -1 && currentIndex !== -1) {
        const [start, end] =
          anchorIndex < currentIndex
            ? [anchorIndex, currentIndex]
            : [currentIndex, anchorIndex];
        const rangeIds = filteredIds.slice(start, end + 1);

        setSelectedIds((currentSelectedIds) => {
          if (isToggle) {
            const merged = new Set(currentSelectedIds);
            rangeIds.forEach((id) => merged.add(id));
            return Array.from(merged);
          }
          return rangeIds;
        });
        setSelectionAnchorId(itemId);
        return;
      }
    }

    if (isToggle) {
      setSelectedIds((currentSelectedIds) => {
        if (currentSelectedIds.includes(itemId)) {
          return currentSelectedIds.filter((id) => id !== itemId);
        }
        return [...currentSelectedIds, itemId];
      });
      setSelectionAnchorId(itemId);
      return;
    }

    setSelectedIds([itemId]);
    setSelectionAnchorId(itemId);
  };

  const handleItemGridEmptyAreaClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (Date.now() < suppressNextItemClickRef.current) {
      suppressNextItemClickRef.current = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setSelectedIds([]);
    setSelectionAnchorId(null);
  }, []);

  const setActiveCustomItemDrag = useCallback((nextState: CustomItemDragState | null) => {
    activeCustomItemDragRef.current = nextState;
    setCustomItemDragState(nextState);
  }, []);

  const setGridReorderDropTarget = useCallback((nextState: GridReorderDropTarget | null) => {
    gridReorderDropStateRef.current = nextState;
    setGridReorderDropState(nextState);
  }, []);

  const clearPointerItemDrag = useCallback(() => {
    pointerItemDragCandidateRef.current = null;
    setActiveCustomItemDrag(null);
    setGridReorderDropTarget(null);
    activeItemDragPayloadRef.current = null;
    activeItemDragAltRef.current = false;
    setIsItemDragActive(false);
    setSidebarCollectionDropState(null);
  }, [setActiveCustomItemDrag, setGridReorderDropTarget]);

  const handleItemPointerDown = useCallback(
    (item: Item, event: React.PointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      const isInSelection = selectedIds.includes(item.id);
      const dragItemIds = isInSelection ? normalizeTargetItemIds(selectedIds) : [item.id];
      if (dragItemIds.length === 0) {
        return;
      }

      if (!isInSelection) {
        setSelectedIds([item.id]);
        setSelectionAnchorId(item.id);
      }

      const sourceCollectionId =
        selectedCollectionId !== null && item.collectionIds.includes(selectedCollectionId)
          ? selectedCollectionId
          : item.collectionId;

      suppressNextItemClickRef.current = 0;
      pointerItemDragCandidateRef.current = {
        pointerId: event.pointerId,
        itemIds: dragItemIds,
        sourceCollectionId,
        startX: event.clientX,
        startY: event.clientY,
      };
      setActiveCustomItemDrag(null);
      console.log("[dnd][custom][candidate]", {
        itemId: item.id,
        dragItemIds,
        sourceCollectionId,
        x: event.clientX,
        y: event.clientY,
      });
    },
    [selectedIds, normalizeTargetItemIds, selectedCollectionId, setActiveCustomItemDrag],
  );

  const reorderSingleItemWithinSelectedCollection = useCallback(
    async (args: { draggedItemId: string; targetItemId: string; position: "before" | "after" }) => {
      if (!selectedCollectionId) {
        return false;
      }
      if (hasActiveGridSubsetFilter) {
        return false;
      }

      const orderedIds = collectionScopedItems.map((item) => item.id);
      const fromIndex = orderedIds.indexOf(args.draggedItemId);
      const targetIndex = orderedIds.indexOf(args.targetItemId);
      if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
        return false;
      }

      const nextOrderedIds = [...orderedIds];
      const [draggedItemId] = nextOrderedIds.splice(fromIndex, 1);
      let insertIndex = nextOrderedIds.indexOf(args.targetItemId);
      if (insertIndex === -1) {
        return false;
      }
      if (args.position === "after") {
        insertIndex += 1;
      }
      nextOrderedIds.splice(insertIndex, 0, draggedItemId);

      const noOp = nextOrderedIds.every((id, index) => id === orderedIds[index]);
      if (noOp) {
        return false;
      }

      setIsActionInProgress(true);
      try {
        await reorderCollectionItemsInDb(selectedCollectionId, nextOrderedIds);
        await reloadItemsFromDb();
        return true;
      } catch (error) {
        console.error("Failed to reorder items in collection:", error);
        void reloadItemsFromDb().catch((reloadError) => {
          console.error("Failed to reload items after reorder error:", reloadError);
        });
        return false;
      } finally {
        setIsActionInProgress(false);
      }
    },
    [collectionScopedItems, hasActiveGridSubsetFilter, reloadItemsFromDb, selectedCollectionId],
  );

  const duplicateItemsIntoSelectedCollectionAtDrop = useCallback(
    async (args: {
      itemIds: string[];
      reorderTarget?: GridReorderDropTarget | null;
    }): Promise<boolean> => {
      if (!selectedCollectionId) {
        return false;
      }
      const duplicatedItems = await duplicateItemsById(args.itemIds, {
        targetCollectionId: selectedCollectionId,
        closeContextMenu: false,
      });
      if (!duplicatedItems || duplicatedItems.length === 0) {
        return false;
      }

      if (
        duplicatedItems.length !== 1 ||
        !args.reorderTarget ||
        hasActiveGridSubsetFilter
      ) {
        return true;
      }

      const duplicatedItemId = duplicatedItems[0].id;
      const orderedIds = collectionScopedItems.map((item) => item.id);
      const targetIndex = orderedIds.indexOf(args.reorderTarget.itemId);
      if (targetIndex === -1) {
        return true;
      }
      const nextOrderedIds = [...orderedIds];
      let insertIndex = targetIndex;
      if (args.reorderTarget.position === "after") {
        insertIndex += 1;
      }
      nextOrderedIds.splice(insertIndex, 0, duplicatedItemId);

      setIsActionInProgress(true);
      try {
        await reorderCollectionItemsInDb(selectedCollectionId, nextOrderedIds);
        await reloadItemsFromDb();
      } catch (error) {
        console.error("Failed to place duplicated item in collection order:", error);
        void reloadItemsFromDb().catch((reloadError) => {
          console.error("Failed to reload items after duplicate-place error:", reloadError);
        });
      } finally {
        setIsActionInProgress(false);
      }
      return true;
    },
    [
      collectionScopedItems,
      duplicateItemsById,
      hasActiveGridSubsetFilter,
      reloadItemsFromDb,
      selectedCollectionId,
    ],
  );

  useEffect(() => {
    const DRAG_THRESHOLD_PX = 6;

    const handlePointerMove = (event: PointerEvent) => {
      const candidate = pointerItemDragCandidateRef.current;
      const active = activeCustomItemDragRef.current;
      if (!candidate && !active) {
        return;
      }

      const trackedPointerId = active?.pointerId ?? candidate?.pointerId;
      if (trackedPointerId !== undefined && event.pointerId !== trackedPointerId) {
        return;
      }

      if (event.buttons === 0) {
        clearPointerItemDrag();
        return;
      }

      let nextActive = active;
      if (!nextActive && candidate) {
        const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
        if (distance < DRAG_THRESHOLD_PX) {
          return;
        }

        const payload: SidebarItemDragPayload = {
          kind: "stumble-item-selection",
          itemIds: candidate.itemIds,
          sourceCollectionId: candidate.sourceCollectionId,
          initiatedAt: Date.now(),
        };
        const initialMode: "move" | "duplicate" =
          event.altKey || keyboardAltPressedRef.current ? "duplicate" : "move";
        activeItemDragPayloadRef.current = payload;
        activeItemDragAltRef.current = initialMode === "duplicate";
        setIsItemDragActive(true);
        pointerItemDragCandidateRef.current = null;
        nextActive = {
          pointerId: candidate.pointerId,
          itemIds: candidate.itemIds,
          sourceCollectionId: candidate.sourceCollectionId,
          clientX: event.clientX,
          clientY: event.clientY,
          targetCollectionId: null,
          mode: initialMode,
        };
        console.log("[dnd][custom][dragstart]", {
          itemIds: candidate.itemIds,
          sourceCollectionId: candidate.sourceCollectionId,
          altKey: initialMode === "duplicate",
        });
      }

      if (!nextActive) {
        return;
      }

      event.preventDefault();
      const rawAltCopy = event.altKey || keyboardAltPressedRef.current;
      const mode: "move" | "duplicate" =
        rawAltCopy || nextActive.mode === "duplicate" ? "duplicate" : "move";
      activeItemDragAltRef.current = mode === "duplicate";
      const canUseGridDropTarget =
        nextActive.itemIds.length === 1 &&
        selectedCollectionId !== null &&
        nextActive.sourceCollectionId === selectedCollectionId &&
        !hasActiveGridSubsetFilter;
      const reorderTarget = canUseGridDropTarget
        ? itemGridReorderTargetFromPoint(event.clientX, event.clientY, nextActive.itemIds[0])
        : null;

      if (reorderTarget) {
        const currentReorderTarget = gridReorderDropStateRef.current;
        setGridReorderDropTarget(
          currentReorderTarget?.itemId === reorderTarget.itemId &&
            currentReorderTarget.position === reorderTarget.position
            ? currentReorderTarget
            : reorderTarget,
        );
        setSidebarCollectionDropState((current) => (current === null ? current : null));
      } else {
        setGridReorderDropTarget(null);
      }

      const targetCollectionId = reorderTarget
        ? null
        : collectionDropTargetIdFromPoint(event.clientX, event.clientY);

      setSidebarCollectionDropState((current) => {
        if (!targetCollectionId) {
          return current === null ? current : null;
        }
        if (current?.collectionId === targetCollectionId && current.mode === mode) {
          return current;
        }
        return { collectionId: targetCollectionId, mode };
      });

      const nextState: CustomItemDragState = {
        ...nextActive,
        clientX: event.clientX,
        clientY: event.clientY,
        targetCollectionId,
        mode,
      };
      setActiveCustomItemDrag(nextState);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const candidate = pointerItemDragCandidateRef.current;
      const active = activeCustomItemDragRef.current;
      if (!candidate && !active) {
        return;
      }

      const trackedPointerId = active?.pointerId ?? candidate?.pointerId;
      if (trackedPointerId !== undefined && event.pointerId !== trackedPointerId) {
        return;
      }

      if (!active) {
        pointerItemDragCandidateRef.current = null;
        return;
      }

      event.preventDefault();
      suppressNextItemClickRef.current = Date.now() + 250;

      const reorderDropTarget = gridReorderDropStateRef.current;
      const droppedInsideItemGrid =
        selectedCollectionId !== null &&
        active.sourceCollectionId === selectedCollectionId &&
        isPointInsideItemGridArea(event.clientX, event.clientY);
      const finalTargetCollectionId =
        collectionDropTargetIdFromPoint(event.clientX, event.clientY) ?? active.targetCollectionId;
      const finalMode: "move" | "duplicate" =
        event.altKey ||
        keyboardAltPressedRef.current ||
        active.mode === "duplicate" ||
        activeItemDragAltRef.current
          ? "duplicate"
          : "move";

      console.log("[dnd][custom][drop]", {
        itemIds: active.itemIds,
        sourceCollectionId: active.sourceCollectionId,
        targetCollectionId: finalTargetCollectionId,
        altKey: finalMode === "duplicate",
      });

      clearPointerItemDrag();

      if (
        finalMode === "move" &&
        reorderDropTarget &&
        active.itemIds.length === 1 &&
        selectedCollectionId !== null &&
        active.sourceCollectionId === selectedCollectionId
      ) {
        void reorderSingleItemWithinSelectedCollection({
          draggedItemId: active.itemIds[0],
          targetItemId: reorderDropTarget.itemId,
          position: reorderDropTarget.position,
        });
        return;
      }

      if (
        finalMode === "duplicate" &&
        selectedCollectionId !== null &&
        active.sourceCollectionId === selectedCollectionId &&
        (reorderDropTarget || droppedInsideItemGrid)
      ) {
        void duplicateItemsIntoSelectedCollectionAtDrop({
          itemIds: active.itemIds,
          reorderTarget: reorderDropTarget,
        });
        return;
      }

      if (!finalTargetCollectionId) {
        return;
      }
      if (finalMode === "move" && active.sourceCollectionId === finalTargetCollectionId) {
        console.log("[dnd][custom][drop] noop same-collection", {
          sourceCollectionId: active.sourceCollectionId,
          targetCollectionId: finalTargetCollectionId,
          itemIds: active.itemIds,
        });
        return;
      }

      void handleCollectionMembershipDrop({
        itemIds: active.itemIds,
        sourceCollectionId: active.sourceCollectionId,
        targetCollectionId: finalTargetCollectionId,
        op: finalMode,
      });
    };

    const handlePointerCancel = () => {
      if (!pointerItemDragCandidateRef.current && !activeCustomItemDragRef.current) {
        return;
      }
      clearPointerItemDrag();
    };

    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("pointercancel", handlePointerCancel, true);
    window.addEventListener("blur", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("pointercancel", handlePointerCancel, true);
      window.removeEventListener("blur", handlePointerCancel);
    };
  }, [
    clearPointerItemDrag,
    duplicateItemsIntoSelectedCollectionAtDrop,
    handleCollectionMembershipDrop,
    hasActiveGridSubsetFilter,
    reorderSingleItemWithinSelectedCollection,
    selectedCollectionId,
    setActiveCustomItemDrag,
    setGridReorderDropTarget,
  ]);

  const handleSidebarCollectionDragOver = useCallback(
    (collectionId: string, event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = parseSidebarItemDragPayload(event.dataTransfer) ?? activeItemDragPayloadRef.current;
      const isAltCopy = event.altKey || keyboardAltPressedRef.current || activeItemDragAltRef.current;
      const mode: "move" | "duplicate" = isAltCopy ? "duplicate" : "move";
      event.dataTransfer.dropEffect = mode === "duplicate" ? "copy" : "move";
      if (!payload) {
        return;
      }
      setSidebarCollectionDropState((current) => {
        if (
          current?.collectionId === collectionId &&
          current.mode === mode
        ) {
          return current;
        }
        return { collectionId, mode };
      });
    },
    [],
  );

  const handleSidebarCollectionDragLeave = useCallback(
    (collectionId: string, event: React.DragEvent<HTMLElement>) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      setSidebarCollectionDropState((current) =>
        current?.collectionId === collectionId ? null : current,
      );
    },
    [],
  );

  const handleSidebarCollectionDrop = useCallback(
    (collectionId: string, event: React.DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = parseSidebarItemDragPayload(event.dataTransfer) ?? activeItemDragPayloadRef.current;
      setIsItemDragActive(false);
      setSidebarCollectionDropState(null);
      activeItemDragPayloadRef.current = null;
      if (!payload) {
        console.warn("[dnd][collection][drop] missing-or-invalid-payload", {
          targetCollectionId: collectionId,
          types: Array.from(event.dataTransfer.types ?? []),
        });
        return;
      }

      const isAltCopy = event.altKey || keyboardAltPressedRef.current || activeItemDragAltRef.current;
      const mode: "move" | "duplicate" = isAltCopy ? "duplicate" : "move";
      if (mode === "move" && payload.sourceCollectionId === collectionId) {
        console.log("[dnd][collection][drop] noop same-collection", {
          targetCollectionId: collectionId,
          sourceCollectionId: payload.sourceCollectionId,
          itemIds: payload.itemIds,
        });
        return;
      }

      void handleCollectionMembershipDrop({
        itemIds: payload.itemIds,
        sourceCollectionId: payload.sourceCollectionId,
        targetCollectionId: collectionId,
        op: mode,
      });
    },
    [handleCollectionMembershipDrop],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        keyboardAltPressedRef.current = true;
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        keyboardAltPressedRef.current = false;
      }
    };
    const handleWindowBlur = () => {
      keyboardAltPressedRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  useEffect(() => {
    if (!isItemDragActive) {
      return;
    }

    const handleDocumentDragOver = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      const payload =
        parseSidebarItemDragPayload(dataTransfer) ?? activeItemDragPayloadRef.current;
      if (!payload) {
        return;
      }
      event.preventDefault();

      const collectionId = collectionDropTargetIdFromPoint(event.clientX, event.clientY);
      const isAltCopy = event.altKey || keyboardAltPressedRef.current || activeItemDragAltRef.current;
      const mode: "move" | "duplicate" = isAltCopy ? "duplicate" : "move";
      console.log("[dnd][document-fallback][dragover-any]", {
        x: event.clientX,
        y: event.clientY,
        targetCollectionId: collectionId,
        altKey: isAltCopy,
        types: Array.from(dataTransfer.types ?? []),
      });
      if (!collectionId) {
        setSidebarCollectionDropState(null);
        dataTransfer.dropEffect = "move";
        return;
      }

      dataTransfer.dropEffect = mode === "duplicate" ? "copy" : "move";
      setSidebarCollectionDropState((current) =>
        current?.collectionId === collectionId && current.mode === mode
          ? current
          : { collectionId, mode },
      );
      console.log("[dnd][document-fallback][dragover]", {
        targetCollectionId: collectionId,
        altKey: isAltCopy,
      });
    };

    const handleDocumentDrop = (event: DragEvent) => {
      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) {
        return;
      }
      const payload =
        parseSidebarItemDragPayload(dataTransfer) ?? activeItemDragPayloadRef.current;
      if (!payload) {
        return;
      }
      const collectionId = collectionDropTargetIdFromPoint(event.clientX, event.clientY);
      console.log("[dnd][document-fallback][drop-any]", {
        x: event.clientX,
        y: event.clientY,
        targetCollectionId: collectionId,
        types: Array.from(dataTransfer.types ?? []),
      });
      if (!collectionId) {
        setIsItemDragActive(false);
        setSidebarCollectionDropState(null);
        activeItemDragPayloadRef.current = null;
        activeItemDragAltRef.current = false;
        return;
      }

      const isAltCopy = event.altKey || keyboardAltPressedRef.current || activeItemDragAltRef.current;
      const mode: "move" | "duplicate" = isAltCopy ? "duplicate" : "move";
      event.preventDefault();
      event.stopPropagation();
      setIsItemDragActive(false);
      setSidebarCollectionDropState(null);
      activeItemDragPayloadRef.current = null;
      activeItemDragAltRef.current = false;
      console.log("[dnd][document-fallback][drop]", {
        targetCollectionId: collectionId,
        altKey: isAltCopy,
        types: Array.from(dataTransfer.types ?? []),
      });

      void handleCollectionMembershipDrop({
        itemIds: payload.itemIds,
        sourceCollectionId: payload.sourceCollectionId,
        targetCollectionId: collectionId,
        op: mode,
      });
    };

    document.addEventListener("dragover", handleDocumentDragOver, true);
    document.addEventListener("drop", handleDocumentDrop, true);
    return () => {
      document.removeEventListener("dragover", handleDocumentDragOver, true);
      document.removeEventListener("drop", handleDocumentDrop, true);
    };
  }, [isItemDragActive, handleCollectionMembershipDrop]);

  const handleDescriptionChange = (description: string) => {
    if (!selectedItem) return;
    descriptionDraftByItemIdRef.current.set(selectedItem.id, description);
    setDescriptionPersistRequest({ itemId: selectedItem.id, description });
    setItems((currentItems) =>
      currentItems.map((item) =>
        item.id === selectedItem.id ? { ...item, description } : item,
      ),
    );
  };

  useEffect(() => {
    if (!descriptionPersistRequest) return;

    const { itemId, description } = descriptionPersistRequest;

    const timeoutId = window.setTimeout(() => {
      void updateItemDescriptionInDb(itemId, description)
        .then((updatedAtMs) => {
          if (descriptionDraftByItemIdRef.current.get(itemId) === description) {
            descriptionDraftByItemIdRef.current.delete(itemId);
          }

          setItems((currentItems) =>
            currentItems.map((item) =>
              item.id === itemId
                ? { ...item, updatedAt: formatDateFromTimestampMs(updatedAtMs) }
                : item,
            ),
          );
        })
        .catch((error) => {
          console.error("Failed to persist item description:", error);
        });
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [descriptionPersistRequest]);

  const handleDropFiles = async (files: FileList) => {
    if (nativeDropEnabled) return;
    const droppedFiles = Array.from(files);
    if (droppedFiles.length === 0) return;
    await importFileObjectsToVault(droppedFiles);
  };

  const handleImportFromPicker = async () => {
    try {
      const selectedPaths = await pickFiles();
      if (selectedPaths.length > 0) {
        await importPathsToVault(selectedPaths);
        return;
      }
    } catch (error) {
      console.warn("Native file picker unavailable, falling back to HTML input:", error);
    }
    filePickerInputRef.current?.click();
  };

  const handleAddUrl = useCallback(() => {
    const enteredValue = window.prompt("Paste a URL (http/https)", "https://");
    if (enteredValue === null) return;

    const normalizedUrl = normalizeHttpUrlInput(enteredValue);
    if (!normalizedUrl) {
      window.alert("Please enter a valid http:// or https:// URL.");
      return;
    }

    void queueBookmarkUrls([normalizedUrl]);
  }, [queueBookmarkUrls]);

  const handleOpenBookmarkUrl = useCallback(async (urlValue: string) => {
    const normalizedUrl = normalizeHttpUrlInput(urlValue);
    if (!normalizedUrl) {
      return;
    }

    try {
      await openUrl(normalizedUrl);
    } catch (error) {
      console.error("Failed to open bookmark URL:", normalizedUrl, error);
    }
  }, []);

  const handleItemDoubleClick = (item: Item) => {
    if (item.type !== "image" || !item.previewUrl) return;
    closeContextMenu();
    setImageModalItemId(item.id);
    setImageModalOpen(true);
  };

  const handleItemContextMenu = (item: Item, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (!selectedIds.includes(item.id)) {
      setSelectedIds([item.id]);
      setSelectionAnchorId(item.id);
    }

    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      itemId: item.id,
    });
  };

  const handleImageThumbnailMissing = useCallback(
    (item: Item) => {
      enqueueImageThumbnailEvaluation(item, { force: true });
    },
    [enqueueImageThumbnailEvaluation],
  );

  const resolveActionTargetIds = useCallback(
    (itemId: string) => (selectedIds.includes(itemId) ? selectedIds : [itemId]),
    [selectedIds],
  );

  const handleConfirmDelete = useCallback(() => {
    const targetIds = normalizeTargetItemIds(deleteConfirmItemIds);
    setDeleteConfirmItemIds([]);
    closeContextMenu();
    if (targetIds.length === 0) return;

    if (selectedCollectionId !== null) {
      const activeCollectionDeleteIds = itemsRef.current
        .filter(
          (item) => targetIds.includes(item.id) && item.collectionIds.includes(selectedCollectionId),
        )
        .map((item) => item.id);
      if (activeCollectionDeleteIds.length > 0) {
        void applyCollectionMembershipTransfer({
          itemIds: activeCollectionDeleteIds,
          sourceCollectionId: selectedCollectionId,
          targetCollectionId: null,
          mode: "move",
        });
        return;
      }
    }

    void performDeleteItems(targetIds);
  }, [
    deleteConfirmItemIds,
    normalizeTargetItemIds,
    closeContextMenu,
    selectedCollectionId,
    applyCollectionMembershipTransfer,
    performDeleteItems,
  ]);

  const handleContextMenuAction = (action: ContextMenuAction, itemId: string) => {
    if (action === "retry-import") {
      console.log("Retry import action is not wired yet:", itemId);
      closeContextMenu();
      return;
    }

    if (action === "retry-thumbnail") {
      const item = items.find((entry) => entry.id === itemId);
      if (item?.type === "image") {
        enqueueImageThumbnailEvaluation(item, { force: true });
      }
      closeContextMenu();
      return;
    }

    if (action === "open") {
      const item = items.find((entry) => entry.id === itemId);
      if (item?.type === "image" && item.previewUrl) {
        setImageModalItemId(item.id);
        setImageModalOpen(true);
      }
      closeContextMenu();
      return;
    }

    if (action === "duplicate") {
      closeContextMenu();
      void duplicateItemsById(resolveActionTargetIds(itemId));
      return;
    }

    if (action === "move") {
      requestMoveItems(resolveActionTargetIds(itemId));
      closeContextMenu();
      return;
    }

    if (action === "delete") {
      requestDeleteItems(resolveActionTargetIds(itemId));
      closeContextMenu();
      return;
    }

    console.log("Context menu action:", action, itemId);
    closeContextMenu();
  };

  useEffect(() => {
    const handleDuplicateShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const key = event.key.toLowerCase();
      const isDuplicateKey = key === "d" || event.code === "KeyD";
      const hasDuplicateModifier = event.ctrlKey || event.metaKey;
      if (!hasDuplicateModifier || event.altKey || event.shiftKey || !isDuplicateKey) {
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (imageModalOpen || deleteConfirmItemIds.length > 0 || moveTargetItemIds.length > 0) {
        return;
      }

      let targetIds: string[] = [];
      if (contextMenu.open && contextMenu.itemId) {
        targetIds = resolveActionTargetIds(contextMenu.itemId);
      } else if (selectedIds.length > 0) {
        targetIds = selectedIds;
      }
      if (targetIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
      void duplicateItemsById(targetIds);
    };

    window.addEventListener("keydown", handleDuplicateShortcut, true);
    return () => window.removeEventListener("keydown", handleDuplicateShortcut, true);
  }, [
    contextMenu.open,
    contextMenu.itemId,
    deleteConfirmItemIds.length,
    duplicateItemsById,
    imageModalOpen,
    moveTargetItemIds.length,
    resolveActionTargetIds,
    selectedIds,
    closeContextMenu,
  ]);

  const moveTargetCollectionIds = useMemo(() => {
    const ids = new Set(moveTargetItemIds);
    const collectionIds = new Set<string | null>();
    items.forEach((item) => {
      if (ids.has(item.id)) {
        if (selectedCollectionId && item.collectionIds.includes(selectedCollectionId)) {
          collectionIds.add(selectedCollectionId);
          return;
        }
        collectionIds.add(item.collectionId);
      }
    });
    return collectionIds;
  }, [items, moveTargetItemIds, selectedCollectionId]);

  const renderMoveCollectionButtons = (
    nodes: CollectionTreeNode[],
    level = 0,
  ): React.ReactNode =>
    nodes.map((node) => (
      <div key={node.collection.id}>
        <button
          type="button"
          className={`move-collection-button ${moveTargetCollectionIds.has(node.collection.id) ? "active" : ""}`}
          style={{ paddingLeft: `${12 + level * 16}px` }}
          onClick={() => {
            void moveSelectedItemsToCollection(node.collection.id);
          }}
          disabled={isActionInProgress}
        >
          <span className="move-collection-node-icon">#</span>
          <span
            className="collection-color"
            style={{ backgroundColor: node.collection.color }}
            aria-hidden="true"
          />
          <span>{node.collection.name}</span>
        </button>
        {node.children.length > 0
          ? renderMoveCollectionButtons(node.children, level + 1)
          : null}
      </div>
    ));

  return (
    <main
      className="app-layout"
      data-theme="dark"
      style={
        {
          "--left-panel-width": `${leftPanelWidth}px`,
          "--right-panel-width": `${rightPanelWidth}px`,
        } as React.CSSProperties
      }
    >
        <Sidebar
          collections={collectionTree}
          tags={tags}
          tagColorPalette={TAG_COLOR_PALETTE}
          selectedCollectionId={selectedCollectionId}
          selectedTagId={selectedTagId}
          isItemDragActive={isItemDragActive}
          onSelectCollection={handleSidebarSelectCollection}
          onSelectTag={handleSidebarSelectTag}
          onSelectMenuView={handleSidebarSelectMenuView}
          onCreateCollection={createCollection}
          onRenameCollection={renameCollection}
          onDeleteCollection={requestDeleteCollection}
          onCreateTag={createTag}
          onRenameTag={renameTag}
          onDuplicateTag={duplicateTag}
          onUpdateTagColor={updateTagColor}
          onDeleteTag={requestDeleteTag}
          onReorderTags={reorderTags}
          onDropTagOnItem={addTagToItem}
          collectionDropTargetId={sidebarCollectionDropState?.collectionId ?? null}
          collectionDropMode={sidebarCollectionDropState?.mode ?? null}
        onCollectionDragOver={handleSidebarCollectionDragOver}
        onCollectionDragLeave={handleSidebarCollectionDragLeave}
        onCollectionDrop={handleSidebarCollectionDrop}
      />
      <div
        className="panel-resize-handle panel-resize-handle-left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onMouseDown={handleStartLeftPanelResize}
      />

      <section className="content-layout">
        <Topbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          availableTags={tags}
          advancedFilters={advancedFilters}
          onAdvancedFiltersChange={setAdvancedFilters}
          activeFilterChips={activeTopbarFilterChips}
          onRemoveFilterChip={handleRemoveTopbarFilterChip}
          onClearAllFilterChips={handleClearAllTopbarFilters}
          tileSize={tileSize}
          onTileSizeChange={setTileSize}
          sortOption={sortOption}
          onSortOptionChange={setSortOption}
          onAddUrl={handleAddUrl}
          onImport={() => {
            void handleImportFromPicker();
          }}
        />
        <input
          ref={filePickerInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const inputFiles = event.currentTarget.files;
            if (inputFiles && inputFiles.length > 0) {
              void importFileObjectsToVault(Array.from(inputFiles));
            }
            event.currentTarget.value = "";
          }}
        />
        <ItemGrid
          items={filteredItems}
          selectedIds={selectedIds}
          tileSize={tileSize}
          reorderDropTargetItemId={gridReorderDropState?.itemId ?? null}
          reorderDropPosition={gridReorderDropState?.position ?? null}
          onSelectItem={handleSelectItem}
          onEmptyAreaClick={handleItemGridEmptyAreaClick}
          onItemPointerDown={handleItemPointerDown}
          onItemDoubleClick={handleItemDoubleClick}
          onItemContextMenu={handleItemContextMenu}
          onImageThumbnailMissing={handleImageThumbnailMissing}
          onDropFiles={handleDropFiles}
          onDropTagOnItem={addTagToItem}
        />
      </section>

      <div
        className="panel-resize-handle panel-resize-handle-right"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        onMouseDown={handleStartRightPanelResize}
      />

      <PreviewPanel
        selectedCount={selectedIds.length}
        item={selectedItem}
        availableTags={tags}
        onDescriptionChange={handleDescriptionChange}
        onSetItemRating={handleSetItemRating}
        onToggleItemFavorite={handleToggleItemFavorite}
        onUpdateItemTags={updateItemTagIds}
        onOpenBookmarkUrl={handleOpenBookmarkUrl}
        onDeleteSelection={() => requestDeleteItems(selectedIds)}
        onMoveSelection={() => requestMoveItems(selectedIds)}
        onDuplicateSelection={() => {
          void duplicateItemsById(selectedIds);
        }}
      />

      {customItemDragState && (
        <div
          className={`custom-item-drag-ghost ${
            customItemDragState.mode === "duplicate" ? "duplicate" : "move"
          }`}
          style={
            {
              left: `${customItemDragState.clientX + 14}px`,
              top: `${customItemDragState.clientY + 14}px`,
            } as React.CSSProperties
          }
          aria-hidden="true"
        >
          <span className="custom-item-drag-ghost-label">
            {customItemDragState.mode === "duplicate" ? "Copy to collection" : "Move to collection"}
          </span>
          <strong className="custom-item-drag-ghost-count">
            {customItemDragState.itemIds.length} item
            {customItemDragState.itemIds.length === 1 ? "" : "s"}
          </strong>
        </div>
      )}

      <ContextMenu
        open={contextMenu.open}
        x={contextMenu.x}
        y={contextMenu.y}
        itemId={contextMenu.itemId}
        canRetryImport={contextMenuItem?.importStatus === "error"}
        canRetryThumbnail={
          contextMenuItem?.type === "image" && contextMenuItem.thumbStatus === "error"
        }
        menuRef={contextMenuRef}
        onAction={handleContextMenuAction}
      />

      {deleteCollectionConfirm && (
        <div
          className="action-modal-backdrop"
          onClick={() => {
            if (isActionInProgress) return;
            setDeleteCollectionConfirm(null);
          }}
          role="presentation"
        >
          <div
            className="action-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Delete collection confirmation"
          >
            <h3 className="action-modal-title">Delete collection?</h3>
            <p className="action-modal-body">
              This will permanently delete {deleteCollectionConfirm.itemsCount} items and{" "}
              {deleteCollectionConfirm.subcollectionsCount} subcollections. This can&apos;t be
              undone.
            </p>
            <div className="action-modal-footer">
              <button
                type="button"
                className="action-modal-button"
                onClick={() => setDeleteCollectionConfirm(null)}
                disabled={isActionInProgress}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal-button danger"
                onClick={handleConfirmDeleteCollection}
                disabled={isActionInProgress}
                autoFocus
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTagConfirm && (
        <div
          className="action-modal-backdrop"
          onClick={() => {
            if (isActionInProgress) return;
            setDeleteTagConfirm(null);
          }}
          role="presentation"
        >
          <div
            className="action-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Delete tag confirmation"
          >
            <h3 className="action-modal-title">Delete tag?</h3>
            <p className="action-modal-body">
              Delete <strong>{deleteTagConfirm.tagName}</strong>
              {deleteTagConfirm.itemsCount > 0
                ? ` and remove it from ${deleteTagConfirm.itemsCount} item${
                    deleteTagConfirm.itemsCount === 1 ? "" : "s"
                  }?`
                : "?"}
            </p>
            <div className="action-modal-footer">
              <button
                type="button"
                className="action-modal-button"
                onClick={() => setDeleteTagConfirm(null)}
                disabled={isActionInProgress}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal-button danger"
                onClick={() => {
                  void handleConfirmDeleteTag();
                }}
                disabled={isActionInProgress}
                autoFocus
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmItemIds.length > 0 && (
        <div
          className="action-modal-backdrop"
          onClick={() => setDeleteConfirmItemIds([])}
          role="presentation"
        >
          <div
            className="action-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Delete confirmation"
          >
            <h3 className="action-modal-title">
              {deleteConfirmItemIds.length === 1
                ? "Delete this item?"
                : `Delete ${deleteConfirmItemIds.length} items?`}
            </h3>
            <div className="action-modal-footer">
              <button
                type="button"
                className="action-modal-button"
                onClick={() => setDeleteConfirmItemIds([])}
                disabled={isActionInProgress}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-modal-button danger"
                onClick={handleConfirmDelete}
                disabled={isActionInProgress}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {moveTargetItemIds.length > 0 && (
        <div
          className="action-modal-backdrop"
          onClick={() => setMoveTargetItemIds([])}
          role="presentation"
        >
          <div
            className="action-modal move-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Move items"
          >
            <h3 className="action-modal-title">
              {moveTargetItemIds.length === 1
                ? "Move this item to..."
                : `Move ${moveTargetItemIds.length} items to...`}
            </h3>
            <div className="move-collection-list">
              <button
                type="button"
                className={`move-collection-button ${moveTargetCollectionIds.has(null) ? "active" : ""}`}
                onClick={() => {
                  void moveSelectedItemsToCollection(null);
                }}
                disabled={isActionInProgress}
              >
                <span className="move-collection-node-icon">#</span>
                <span>No Collection</span>
              </button>
              {renderMoveCollectionButtons(collectionTree)}
            </div>
            <div className="action-modal-footer">
              <button
                type="button"
                className="action-modal-button"
                onClick={() => setMoveTargetItemIds([])}
                disabled={isActionInProgress}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {imageModalOpen && modalItem?.type === "image" && modalItem.previewUrl && (
        <div
          className="image-modal-backdrop"
          onClick={() => {
            setImageModalOpen(false);
            setImageModalItemId(null);
          }}
          role="presentation"
        >
          <div
            className="image-modal-content"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Fullscreen image preview"
          >
            <header className="image-modal-header">
              <div className="image-modal-title">
                {modalItem.filename || modalItem.title}
              </div>
              <div className="image-modal-controls-placeholder" />
            </header>
            <button
              type="button"
              className="image-modal-close"
              onClick={() => {
                setImageModalOpen(false);
                setImageModalItemId(null);
              }}
              aria-label="Close preview"
            >
              X
            </button>
            <div className="image-modal-body">
              <img src={modalItem.previewUrl} alt={modalItem.title} />
            </div>
          </div>
        </div>
      )}

      {snackbar && (
        <div className="snackbar-layer" role="status" aria-live="polite" aria-atomic="true">
          <div className="snackbar">
            <span className="snackbar-message">{snackbar.message}</span>
            {snackbar.canUndo ? (
              <button
                type="button"
                className="snackbar-action"
                onClick={handleUndoSnackbar}
              >
                Undo
              </button>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
