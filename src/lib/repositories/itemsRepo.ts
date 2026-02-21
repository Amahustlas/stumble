import {
  deleteDbItemsWithCleanup,
  deleteDbItems,
  insertDbItem,
  insertDbItemsBatch,
  updateDbItemsCollection,
  type DbDeleteItemsWithCleanupResult,
  updateDbItemDescription,
  updateDbItemMediaState,
  finalizeDbItemImport,
  markDbItemImportError,
  type DbUpdateItemsCollectionResult,
  type DbInsertItemInput,
  type DbThumbStatus,
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

export async function updateItemDescription(
  itemId: string,
  description: string,
): Promise<number> {
  return updateDbItemDescription(itemId, description);
}

export async function updateItemMediaState(params: {
  itemId: string;
  width?: number | null;
  height?: number | null;
  thumbStatus?: DbThumbStatus;
}): Promise<number> {
  return updateDbItemMediaState(params);
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
