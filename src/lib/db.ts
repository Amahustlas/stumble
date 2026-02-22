import { invoke } from "@tauri-apps/api/core";

export type DbCollectionRecord = {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  createdAt: number;
  updatedAt: number;
};

export interface Collection {
  id: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  parentId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DbThumbStatus = "ready" | "pending" | "skipped" | "error";
export type DbImportStatus = "ready" | "processing" | "error";
export type DbMetaStatus = "ready" | "pending" | "error";

export type DbItemRecord = {
  id: string;
  collectionId: string | null;
  type: string;
  title: string;
  filename: string;
  vaultKey: string;
  vaultPath: string;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  thumbStatus: DbThumbStatus;
  importStatus: DbImportStatus;
  url: string | null;
  faviconPath: string | null;
  metaStatus: DbMetaStatus;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
};

export type DbCollectionItemRecord = {
  id: string;
  collectionId: string;
  itemId: string;
  customTitle: string | null;
  customDescription: string | null;
  sortIndex: number;
  createdAt: number;
};

export type DbAppState = {
  collections: DbCollectionRecord[];
  collectionItems: DbCollectionItemRecord[];
  items: DbItemRecord[];
};

export type DbInsertItemInput = {
  id: string;
  collectionId: string | null;
  type: string;
  title: string;
  filename: string;
  vaultKey: string;
  vaultPath: string;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  thumbStatus: DbThumbStatus;
  importStatus: DbImportStatus;
  url: string | null;
  faviconPath: string | null;
  metaStatus: DbMetaStatus;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
};

export type DbVaultCleanupEntry = {
  vaultKey: string;
  vaultPath: string;
  sha256: string;
  ext: string;
  deletedFromDisk: boolean;
};

export type DbDeleteItemsWithCleanupResult = {
  deletedRows: number;
  cleanup: DbVaultCleanupEntry[];
};

export type DbUpdateItemsCollectionResult = {
  updatedRows: number;
  updatedAt: number;
};

export type DbUpdateCollectionMembershipsResult = {
  createdRows: number;
  updatedRows: number;
  deletedRows: number;
  skippedRows: number;
  updatedAt: number;
};

export type DbReorderCollectionItemsResult = {
  updatedRows: number;
  skippedRows: number;
  updatedAt: number;
};

function toCollection(record: DbCollectionRecord): Collection {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? undefined,
    icon: record.icon,
    color: record.color,
    parentId: record.parentId ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function initDb(): Promise<string> {
  return invoke<string>("init_db");
}

export async function loadDbAppState(): Promise<DbAppState> {
  return invoke<DbAppState>("load_app_state");
}

export async function createCollection(params: {
  name: string;
  parentId?: string | null;
  icon: string;
  color: string;
  description?: string;
}): Promise<Collection> {
  const row = await invoke<DbCollectionRecord>("create_collection", {
    name: params.name,
    parentId: params.parentId ?? null,
    icon: params.icon,
    color: params.color,
    description: params.description ?? null,
  });
  return toCollection(row);
}

export async function getAllCollections(): Promise<Collection[]> {
  const rows = await invoke<DbCollectionRecord[]>("get_all_collections");
  return rows.map(toCollection);
}

export async function deleteCollection(id: string): Promise<number> {
  return invoke<number>("delete_collection", { id });
}

export async function updateCollectionName(id: string, name: string): Promise<number> {
  return invoke<number>("update_collection_name", { id, name });
}

export async function insertDbItem(item: DbInsertItemInput): Promise<void> {
  return invoke<void>("insert_item", { item });
}

export async function insertDbItemsBatch(items: DbInsertItemInput[]): Promise<void> {
  return invoke<void>("insert_items_batch", { items });
}

export async function deleteDbItems(itemIds: string[]): Promise<number> {
  return invoke<number>("delete_items", { itemIds });
}

export async function deleteDbItemsWithCleanup(
  itemIds: string[],
): Promise<DbDeleteItemsWithCleanupResult> {
  return invoke<DbDeleteItemsWithCleanupResult>("delete_items_with_cleanup", { itemIds });
}

export async function updateDbItemsCollection(
  itemIds: string[],
  collectionId: string | null,
): Promise<DbUpdateItemsCollectionResult> {
  return invoke<DbUpdateItemsCollectionResult>("update_items_collection", {
    itemIds,
    collectionId,
  });
}

export async function moveDbCollectionItemMemberships(params: {
  itemIds: string[];
  sourceCollectionId: string | null;
  targetCollectionId: string | null;
}): Promise<DbUpdateCollectionMembershipsResult> {
  return invoke<DbUpdateCollectionMembershipsResult>("move_collection_item_memberships", {
    itemIds: params.itemIds,
    sourceCollectionId: params.sourceCollectionId,
    targetCollectionId: params.targetCollectionId,
  });
}

export async function addDbItemsToCollection(
  itemIds: string[],
  collectionId: string,
): Promise<DbUpdateCollectionMembershipsResult> {
  return invoke<DbUpdateCollectionMembershipsResult>("add_items_to_collection", {
    itemIds,
    collectionId,
  });
}

export async function reorderDbCollectionItems(
  collectionId: string,
  orderedItemIds: string[],
): Promise<DbReorderCollectionItemsResult> {
  return invoke<DbReorderCollectionItemsResult>("reorder_collection_items", {
    collectionId,
    orderedItemIds,
  });
}

export async function updateDbItemDescription(
  itemId: string,
  description: string,
): Promise<number> {
  return invoke<number>("update_item_description", { itemId, description });
}

export async function updateDbItemMediaState(params: {
  itemId: string;
  width?: number | null;
  height?: number | null;
  thumbStatus?: DbThumbStatus;
}): Promise<number> {
  return invoke<number>("update_item_media_state", {
    input: {
      itemId: params.itemId,
      width: params.width ?? null,
      height: params.height ?? null,
      thumbStatus: params.thumbStatus ?? null,
    },
  });
}

export async function updateDbItemBookmarkMetadata(input: {
  itemId: string;
  url?: string | null;
  title?: string | null;
  filename?: string | null;
  faviconPath?: string | null;
  metaStatus: DbMetaStatus;
}): Promise<number> {
  return invoke<number>("update_item_bookmark_metadata", {
    input: {
      itemId: input.itemId,
      url: input.url ?? null,
      title: input.title ?? null,
      filename: input.filename ?? null,
      faviconPath: input.faviconPath ?? null,
      metaStatus: input.metaStatus,
    },
  });
}

export async function finalizeDbItemImport(input: {
  itemId: string;
  title: string;
  filename: string;
  vaultKey: string;
  vaultPath: string;
  width?: number | null;
  height?: number | null;
  thumbStatus: DbThumbStatus;
}): Promise<number> {
  return invoke<number>("finalize_item_import", {
    input: {
      itemId: input.itemId,
      title: input.title,
      filename: input.filename,
      vaultKey: input.vaultKey,
      vaultPath: input.vaultPath,
      width: input.width ?? null,
      height: input.height ?? null,
      thumbStatus: input.thumbStatus,
    },
  });
}

export async function markDbItemImportError(itemId: string): Promise<number> {
  return invoke<number>("mark_item_import_error", {
    input: {
      itemId,
    },
  });
}
