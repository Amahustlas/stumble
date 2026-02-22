import { invoke } from "@tauri-apps/api/core";

export type BookmarkMetadataFetchResult = {
  finalUrl: string;
  title: string | null;
  faviconPath: string | null;
  faviconExt: string | null;
  faviconUrlCandidate: string | null;
};

export async function fetchBookmarkMetadata(url: string): Promise<BookmarkMetadataFetchResult> {
  return invoke<BookmarkMetadataFetchResult>("fetch_bookmark_metadata", { url });
}
