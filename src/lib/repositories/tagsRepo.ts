import {
  createTag as createTagInDb,
  deleteTag as deleteTagInDb,
  duplicateTag as duplicateTagInDb,
  getAllTags as getAllTagsInDb,
  reorderTags as reorderTagsInDb,
  updateTagColor as updateTagColorInDb,
  updateTagName as updateTagNameInDb,
  type DbReorderTagsResult,
  type Tag,
} from "../db";

export async function createTag(params: { name: string; color: string }): Promise<Tag> {
  return createTagInDb(params);
}

export async function getAllTags(): Promise<Tag[]> {
  return getAllTagsInDb();
}

export async function updateTagName(id: string, name: string): Promise<number> {
  return updateTagNameInDb(id, name);
}

export async function updateTagColor(id: string, color: string): Promise<number> {
  return updateTagColorInDb(id, color);
}

export async function duplicateTag(id: string): Promise<Tag> {
  return duplicateTagInDb(id);
}

export async function deleteTag(id: string): Promise<number> {
  return deleteTagInDb(id);
}

export async function reorderTags(tagIds: string[]): Promise<DbReorderTagsResult> {
  return reorderTagsInDb(tagIds);
}
