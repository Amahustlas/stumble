import { loadDbAppState, type DbCollectionRecord } from "../db";

export async function loadCollections(): Promise<DbCollectionRecord[]> {
  const state = await loadDbAppState();
  return state.collections;
}
