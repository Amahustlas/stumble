import { invoke } from "@tauri-apps/api/core";

export type VaultImportResult = {
  vaultPath: string;
  sha256: string;
  ext: string;
  size: number;
  createdAt: string;
  originalFilename: string;
};

export type ImportPipelineMetrics = {
  hashMs: number;
  copyMs: number;
  metadataMs: number;
  thumbMs: number;
  totalMs: number;
  deduped: boolean;
};

export type ImportPipelineResult = VaultImportResult & {
  width: number | null;
  height: number | null;
  thumbStatus: "ready" | "pending" | "skipped" | "error";
  thumbPath: string | null;
  metrics: ImportPipelineMetrics;
};

export type VaultFileEntry = {
  vaultPath: string;
  refs: number;
  size: number;
};

export function buildVaultKey(sha256: string, ext: string): string {
  return `${sha256}.${ext.toLowerCase()}`;
}

export function parseVaultKey(vaultKey: string): { sha256: string; ext: string } {
  const lastDot = vaultKey.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === vaultKey.length - 1) {
    throw new Error(`Invalid vault key: ${vaultKey}`);
  }

  return {
    sha256: vaultKey.slice(0, lastDot),
    ext: vaultKey.slice(lastDot + 1).toLowerCase(),
  };
}

export async function ensureStorageRoot(): Promise<string> {
  return invoke<string>("ensure_storage_root");
}

export async function computeSha256(filePath: string): Promise<string> {
  return invoke<string>("compute_sha256", { filePath });
}

export async function importToVault(originalPath: string): Promise<VaultImportResult> {
  return invoke<VaultImportResult>("import_to_vault", { originalPath });
}

export async function importBytesToVault(params: {
  bytes: Uint8Array;
  originalFilename?: string;
  ext?: string;
}): Promise<VaultImportResult> {
  return invoke<VaultImportResult>("import_bytes_to_vault", {
    bytes: Array.from(params.bytes),
    originalFilename: params.originalFilename,
    ext: params.ext,
  });
}

export async function processImportPathJob(params: {
  originalPath: string;
  generateThumb?: boolean;
}): Promise<ImportPipelineResult> {
  return invoke<ImportPipelineResult>("process_import_path_job", {
    originalPath: params.originalPath,
    generateThumb: params.generateThumb ?? true,
  });
}

export async function processImportBytesJob(params: {
  bytes: Uint8Array;
  originalFilename?: string;
  ext?: string;
  generateThumb?: boolean;
}): Promise<ImportPipelineResult> {
  return invoke<ImportPipelineResult>("process_import_bytes_job", {
    bytes: Array.from(params.bytes),
    originalFilename: params.originalFilename,
    ext: params.ext,
    generateThumb: params.generateThumb ?? true,
  });
}

export async function pickFiles(): Promise<string[]> {
  return invoke<string[]>("pick_files");
}

export async function removeFromVaultIfUnreferenced(params: {
  sha256: string;
  ext: string;
  refs: number;
}): Promise<boolean> {
  if (params.refs > 0) {
    return false;
  }
  return invoke<boolean>("remove_from_vault", {
    sha256: params.sha256,
    ext: params.ext,
  });
}
