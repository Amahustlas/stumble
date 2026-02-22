import {
  createCollection as createCollectionInDb,
  deleteCollection as deleteCollectionInDb,
  getAllCollections as getAllCollectionsInDb,
  loadDbAppState,
  updateCollectionName as updateCollectionNameInDb,
  type Collection,
  type DbCollectionRecord,
} from "../db";

export async function loadCollections(): Promise<DbCollectionRecord[]> {
  const state = await loadDbAppState();
  return state.collections;
}

export async function createCollection(params: {
  name: string;
  parentId?: string | null;
  icon: string;
  color: string;
  description?: string;
}): Promise<Collection> {
  return createCollectionInDb(params);
}

export async function getAllCollections(): Promise<Collection[]> {
  return getAllCollectionsInDb();
}

export async function deleteCollection(id: string): Promise<number> {
  return deleteCollectionInDb(id);
}

export async function updateCollectionName(id: string, name: string): Promise<number> {
  return updateCollectionNameInDb(id, name);
}
