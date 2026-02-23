import {
  deleteDbItemsWithCleanup,
  deleteDbItems,
  insertDbItem,
  insertDbItemsBatch,
  moveDbCollectionItemMemberships,
  addDbItemsToCollection,
  reorderDbCollectionItems,
  updateDbItemsCollection,
  type DbDeleteItemsWithCleanupResult,
  updateDbItemDescription,
  updateDbItemTags,
  updateDbItemMediaState,
  updateDbItemBookmarkMetadata,
  finalizeDbItemImport,
  markDbItemImportError,
  type DbUpdateItemsCollectionResult,
  type DbUpdateCollectionMembershipsResult,
  type DbReorderCollectionItemsResult,
  type DbInsertItemInput,
  type DbThumbStatus,
  type DbMetaStatus,
} from "../db";

export async function insertItem(item: DbInsertItemInput): Promise<void> {
  await insertDbItem(item);
}

export async function insertItems(items: DbInsertItemInput[]): Promise<void> {
  await insertDbItemsBatch(items);
}

export async function deleteItemsByIds(itemIds: string[]): Promise<number> {
  return deleteDbItems(itemIds);
}

export async function deleteItemsByIdsWithCleanup(
  itemIds: string[],
): Promise<DbDeleteItemsWithCleanupResult> {
  return deleteDbItemsWithCleanup(itemIds);
}

export async function moveItemsToCollection(
  itemIds: string[],
  collectionId: string | null,
): Promise<DbUpdateItemsCollectionResult> {
  return updateDbItemsCollection(itemIds, collectionId);
}

export async function moveCollectionItemMemberships(params: {
  itemIds: string[];
  sourceCollectionId: string | null;
  targetCollectionId: string | null;
}): Promise<DbUpdateCollectionMembershipsResult> {
  return moveDbCollectionItemMemberships(params);
}

export async function addItemsToCollection(
  itemIds: string[],
  collectionId: string,
): Promise<DbUpdateCollectionMembershipsResult> {
  return addDbItemsToCollection(itemIds, collectionId);
}

export async function reorderCollectionItems(
  collectionId: string,
  orderedItemIds: string[],
): Promise<DbReorderCollectionItemsResult> {
  return reorderDbCollectionItems(collectionId, orderedItemIds);
}

export async function updateItemDescription(
  itemId: string,
  description: string,
): Promise<number> {
  return updateDbItemDescription(itemId, description);
}

export async function updateItemTags(
  itemId: string,
  tagIds: string[],
): Promise<number> {
  return updateDbItemTags(itemId, tagIds);
}

export async function updateItemMediaState(params: {
  itemId: string;
  width?: number | null;
  height?: number | null;
  thumbStatus?: DbThumbStatus;
}): Promise<number> {
  return updateDbItemMediaState(params);
}

export async function updateItemBookmarkMetadata(params: {
  itemId: string;
  url?: string | null;
  title?: string | null;
  filename?: string | null;
  faviconPath?: string | null;
  metaStatus: DbMetaStatus;
}): Promise<number> {
  return updateDbItemBookmarkMetadata(params);
}

export async function finalizeItemImport(params: {
  itemId: string;
  title: string;
  filename: string;
  vaultKey: string;
  vaultPath: string;
  width?: number | null;
  height?: number | null;
  thumbStatus: DbThumbStatus;
}): Promise<number> {
  return finalizeDbItemImport(params);
}

export async function markItemImportError(itemId: string): Promise<number> {
  return markDbItemImportError(itemId);
}
