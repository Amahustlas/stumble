import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import ContextMenu, { type ContextMenuAction } from "./components/ContextMenu";
import ItemGrid from "./components/ItemGrid";
import PreviewPanel from "./components/PreviewPanel";
import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import {
  initDb,
  loadDbAppState,
  type Collection,
  type DbInsertItemInput,
  type DbItemRecord,
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
  moveItemsToCollection as moveItemsToCollectionInDb,
  updateItemDescription as updateItemDescriptionInDb,
  updateItemMediaState as updateItemMediaStateInDb,
} from "./lib/repositories/itemsRepo";
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

export type ItemType = "bookmark" | "image" | "video" | "pdf" | "file" | "note";
export type ThumbStatus = "ready" | "pending" | "skipped" | "error";
export type ImportStatus = "ready" | "processing" | "error";
export type ItemStatus = "saved" | "archived" | "processing" | "error";

export type Item = {
  id: string;
  filename: string;
  type: ItemType;
  title: string;
  description: string;
  rating: number;
  status: ItemStatus;
  importStatus: ImportStatus;
  tags: string[];
  collectionId: string | null;
  collectionPath: string;
  createdAt: string;
  updatedAt: string;
  size: string;
  format: string;
  vaultKey?: string;
  vaultPath?: string;
  previewUrl?: string;
  thumbPath?: string;
  thumbUrl?: string;
  hasThumb: boolean;
  thumbStatus: ThumbStatus;
  width?: number;
  height?: number;
  sizeBytes?: number;
  noteText?: string;
  sourceUrl?: string;
};

const initialItems: Item[] = [];

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi)$/i;
const THUMB_SKIP_MAX_DIMENSION = 640;
const THUMB_JOB_TIMEOUT_MS = 60_000;
const THUMB_JOB_MAX_RETRIES = 1;
const THUMB_QUEUE_START_DELAY_MS = 700;
const USER_INTERACTION_IDLE_MS = 600;
const IMPORT_QUEUE_CONCURRENCY = 1;
const DEFAULT_COLLECTION_ICON = "folder";
const DEFAULT_COLLECTION_COLOR = "#8B8B8B";
const DEFAULT_COLLECTION_NAME = "New Collection";

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

function deriveItemStatus(importStatus: ImportStatus): ItemStatus {
  if (importStatus === "processing") return "processing";
  if (importStatus === "error") return "error";
  return "saved";
}

function formatDateFromTimestampMs(timestampMs: number): string {
  const parsed = new Date(timestampMs);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
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

async function readClipboardImageAsPngBytes(): Promise<Uint8Array | null> {
  if (!("clipboard" in navigator) || typeof navigator.clipboard.read !== "function") {
    return null;
  }

  const clipboardItems = await navigator.clipboard.read();
  for (const clipboardItem of clipboardItems) {
    const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
    if (!imageType) continue;
    const imageBlob = await clipboardItem.getType(imageType);
    return blobToPngBytes(imageBlob);
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
  return {
    id: itemId ?? createItemId(),
    filename,
    type,
    title: fileTitleFromFilename(filename),
    description: "Importing...",
    rating: 0,
    status: "processing",
    importStatus: "processing",
    tags: ["imported"],
    collectionId,
    collectionPath,
    createdAt: now,
    updatedAt: now,
    size: "-",
    format: fileFormatFromFilename(filename),
    previewUrl: type === "image" ? previewUrl : undefined,
    hasThumb: type !== "image",
    thumbStatus: type === "image" ? "pending" : "ready",
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
    description: item.description,
    createdAt: createdAtMs,
    updatedAt: updatedAtMs,
    tags: item.tags,
  };
}

function mapDbItemToItem(args: {
  item: DbItemRecord;
  collectionPathById: Map<string, string>;
  thumbsRoot: string | null;
}): Item {
  const { item, collectionPathById, thumbsRoot } = args;
  const itemType = normalizeItemType(item.type);
  const thumbStatus = normalizeThumbStatus(item.thumbStatus, itemType);
  const importStatus = normalizeImportStatus(item.importStatus);
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
  return {
    id: item.id,
    filename: item.filename,
    type: itemType,
    title: item.title || fileTitleFromFilename(item.filename),
    description: item.description ?? "",
    rating: 0,
    status: deriveItemStatus(importStatus),
    importStatus,
    tags: item.tags ?? [],
    collectionId: item.collectionId,
    collectionPath:
      item.collectionId !== null
        ? collectionPathById.get(item.collectionId) ?? "All Items"
        : "All Items",
    createdAt: formatDateFromTimestampMs(item.createdAt),
    updatedAt: formatDateFromTimestampMs(item.updatedAt),
    size: "-",
    format: item.filename.split(".").pop()?.toLowerCase() ?? "",
    vaultKey: item.vaultKey,
    vaultPath: item.vaultPath,
    previewUrl,
    thumbPath,
    thumbUrl,
    hasThumb: itemType !== "image" ? true : hasThumb,
    thumbStatus,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
  };
}

function App() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [items, setItems] = useState<Item[]>(initialItems);
  const [searchQuery, setSearchQuery] = useState("");
  const [tileSize, setTileSize] = useState(220);
  const [nativeDropEnabled, setNativeDropEnabled] = useState(false);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [imageModalItemId, setImageModalItemId] = useState<string | null>(null);
  const [deleteConfirmItemIds, setDeleteConfirmItemIds] = useState<string[]>([]);
  const [moveTargetItemIds, setMoveTargetItemIds] = useState<string[]>([]);
  const [isActionInProgress, setIsActionInProgress] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
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
  const importSourceByItemIdRef = useRef<Map<string, ImportSource>>(new Map());
  const transientPreviewUrlByItemIdRef = useRef<Map<string, string>>(new Map());
  const imageEvaluationQueueRef = useRef<DedupeAsyncQueue>(new DedupeAsyncQueue(1));
  const imageThumbnailEvaluationRequestedRef = useRef<Set<string>>(new Set());
  const isUserInteractingRef = useRef(false);
  const userInteractionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  const itemsRef = useRef<Item[]>(initialItems);
  const descriptionDraftByItemIdRef = useRef<Map<string, string>>(new Map());
  const [descriptionPersistRequest, setDescriptionPersistRequest] = useState<{
    itemId: string;
    description: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);

  const collectionTree = useMemo(() => buildCollectionTree(collections), [collections]);
  const collectionPathById = useMemo(
    () => buildCollectionPathMap(collections),
    [collections],
  );

  const selectedCollectionPath =
    selectedCollectionId !== null
      ? collectionPathById.get(selectedCollectionId) ?? "All Items"
      : "All Items";

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

  const deleteCollection = useCallback(
    async (id: string): Promise<void> => {
      const targetCollection = collections.find((collection) => collection.id === id);
      const deletedSubtreeIds = collectCollectionSubtreeIds(collections, id);
      try {
        await deleteCollectionInDb(id);
        const refreshedCollections = await getAllCollectionsInDb();
        setCollections(refreshedCollections);
        setSelectedCollectionId((currentSelectedCollectionId) => {
          if (!currentSelectedCollectionId) return currentSelectedCollectionId;
          if (!deletedSubtreeIds.has(currentSelectedCollectionId)) {
            return currentSelectedCollectionId;
          }

          const fallbackParentId = targetCollection?.parentId ?? null;
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
      }
    },
    [collections],
  );

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

      const removedItems = items.filter((item) => idsToDelete.has(item.id));
      if (removedItems.length === 0) return;

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
      } catch (error) {
        console.error("Failed to delete selected items:", error);
        return;
      } finally {
        setIsActionInProgress(false);
      }

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
      removedItems.forEach((item) => {
        releaseTransientPreviewUrl(item.id);
        descriptionDraftByItemIdRef.current.delete(item.id);
      });
    },
    [items, releaseTransientPreviewUrl],
  );

  const duplicateItemsById = useCallback(
    async (itemIds: string[]) => {
      const targetIds = new Set(normalizeTargetItemIds(itemIds));
      if (targetIds.size === 0) return;
      const sourceItems = items.filter((item) => targetIds.has(item.id));
      if (sourceItems.length === 0) return;

      setIsActionInProgress(true);
      const duplicatedItems: Item[] = [];
      try {
        for (const [index, sourceItem] of sourceItems.entries()) {
          const duplicatedId = createItemId();
          const timestampMs = Date.now() + index;
          const duplicatedItem: Item = {
            ...sourceItem,
            id: duplicatedId,
            createdAt: formatDateFromTimestampMs(timestampMs),
            updatedAt: formatDateFromTimestampMs(timestampMs),
            collectionPath:
              sourceItem.collectionId !== null
                ? collectionPathById.get(sourceItem.collectionId) ?? "All Items"
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
        return;
      } finally {
        setIsActionInProgress(false);
      }

      if (duplicatedItems.length === 0) return;
      console.log("Duplicate action created item ids:", duplicatedItems.map((item) => item.id));
      setItems((currentItems) => [...duplicatedItems, ...currentItems]);
      setSelectedIds(duplicatedItems.map((item) => item.id));
      setSelectionAnchorId(duplicatedItems[duplicatedItems.length - 1]?.id ?? null);
      closeContextMenu();
    },
    [items, normalizeTargetItemIds, collectionPathById, closeContextMenu],
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

      setIsActionInProgress(true);
      try {
        const updateResult = await moveItemsToCollectionInDb(targetIds, collectionId);
        const nextCollectionPath =
          collectionId !== null ? collectionPathById.get(collectionId) ?? "All Items" : "All Items";
        setItems((currentItems) =>
          currentItems.map((item) =>
            targetIds.includes(item.id)
              ? {
                  ...item,
                  collectionId,
                  collectionPath: nextCollectionPath,
                  updatedAt: formatDateFromTimestampMs(updateResult.updatedAt),
                }
              : item,
          ),
        );
        console.log(
          "Move action:",
          targetIds,
          "target collection:",
          collectionId,
          "updated rows:",
          updateResult.updatedRows,
        );
      } catch (error) {
        console.error("Failed to move selected items:", error);
        return;
      } finally {
        setIsActionInProgress(false);
      }

      setMoveTargetItemIds([]);
      closeContextMenu();
    },
    [moveTargetItemIds, normalizeTargetItemIds, collectionPathById, closeContextMenu],
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
        const mappedItems = persistedState.items.map((item) =>
          mapDbItemToItem({
            item,
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
      importSourceByItemIdRef.current.clear();
      imageEvaluationQueueRef.current.dispose();
      imageThumbnailEvaluationRequestedRef.current.clear();
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
    deleteConfirmItemIds.length,
    moveTargetItemIds.length,
    contextMenu.open,
    closeContextMenu,
  ]);

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
    let isActive = true;
    let unlisten: (() => void) | undefined;

    const setupNativeDrop = async () => {
      try {
        const unlistenFromApi = await getCurrentWindow().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          if (event.payload.paths.length === 0) return;
          void importPathsToVault(event.payload.paths);
        });

        if (!isActive) {
          unlistenFromApi();
          return;
        }

        unlisten = unlistenFromApi;
        setNativeDropEnabled(true);
      } catch (error) {
        if (isActive) {
          setNativeDropEnabled(false);
        }
        console.warn("Native Tauri drag-drop listener unavailable:", error);
      }
    };

    void setupNativeDrop();

    return () => {
      isActive = false;
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
    const handleClipboardPasteShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== "v") return;
      if (isEditableTarget(event.target)) return;

      void (async () => {
        try {
          const pngBytes = await readClipboardImageAsPngBytes();
          if (!pngBytes) {
            console.log("Clipboard image not available yet");
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
        } catch (error) {
          console.log("Clipboard image not available yet");
          console.warn("Clipboard image import failed:", error);
        }
      })();
    };

    window.addEventListener("keydown", handleClipboardPasteShortcut);
    return () => window.removeEventListener("keydown", handleClipboardPasteShortcut);
  }, [queueImportSources]);

  const scopedItems = useMemo(() => {
    if (!selectedCollectionId) return items;
    return items.filter((item) => item.collectionId === selectedCollectionId);
  }, [items, selectedCollectionId]);

  const tags = useMemo(() => {
    const uniqueTags = new Set<string>();
    items.forEach((item) => {
      item.tags.forEach((tag) => {
        if (tag.trim().length > 0) {
          uniqueTags.add(tag);
        }
      });
    });
    return Array.from(uniqueTags).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return scopedItems;

    return scopedItems.filter((item) =>
      [
        item.filename,
        item.title,
        item.description,
        item.sourceUrl,
        item.noteText,
        item.tags.join(" "),
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query)),
    );
  }, [scopedItems, searchQuery]);

  const selectedItem =
    selectedIds.length === 1
      ? items.find((item) => item.id === selectedIds[0]) ?? null
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
    void performDeleteItems(targetIds);
  }, [deleteConfirmItemIds, normalizeTargetItemIds, performDeleteItems, closeContextMenu]);

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

  const moveTargetCollectionIds = useMemo(() => {
    const ids = new Set(moveTargetItemIds);
    const collectionIds = new Set<string | null>();
    items.forEach((item) => {
      if (ids.has(item.id)) {
        collectionIds.add(item.collectionId);
      }
    });
    return collectionIds;
  }, [items, moveTargetItemIds]);

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
    <main className="app-layout" data-theme="dark">
      <Sidebar
        collections={collectionTree}
        tags={tags}
        selectedCollectionId={selectedCollectionId}
        onSelectCollection={setSelectedCollectionId}
        onCreateCollection={createCollection}
        onRenameCollection={renameCollection}
        onDeleteCollection={deleteCollection}
      />

      <section className="content-layout">
        <Topbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          tileSize={tileSize}
          onTileSizeChange={setTileSize}
          onAddUrl={() => window.alert("Add URL flow placeholder")}
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
          onSelectItem={handleSelectItem}
          onItemDoubleClick={handleItemDoubleClick}
          onItemContextMenu={handleItemContextMenu}
          onImageThumbnailMissing={handleImageThumbnailMissing}
          onDropFiles={handleDropFiles}
        />
      </section>

      <PreviewPanel
        selectedCount={selectedIds.length}
        item={selectedItem}
        onDescriptionChange={handleDescriptionChange}
        onDeleteSelection={() => requestDeleteItems(selectedIds)}
        onMoveSelection={() => requestMoveItems(selectedIds)}
        onDuplicateSelection={() => {
          void duplicateItemsById(selectedIds);
        }}
      />

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
    </main>
  );
}

export default App;
