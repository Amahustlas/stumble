import { invoke } from "@tauri-apps/api/core";

export const THUMB_MAX_SIZE = 480;

export function buildThumbnailPath(thumbsRoot: string, vaultKey: string): string {
  const normalizedRoot = thumbsRoot.trim().replace(/[\\/]+$/, "");
  if (!normalizedRoot) {
    throw new Error("Cannot build thumbnail path without thumbs root.");
  }

  const normalizedVaultKey = vaultKey.trim();
  if (!normalizedVaultKey) {
    throw new Error("Cannot build thumbnail path without vault key.");
  }

  return `${normalizedRoot}/${normalizedVaultKey}.webp`;
}

export async function ensureThumbsRoot(): Promise<string> {
  return invoke<string>("ensure_thumbs_root");
}

export async function fileExists(path: string): Promise<boolean> {
  return invoke<boolean>("file_exists", { path });
}

export async function generateThumbnail(params: {
  inputPath: string;
  outputPath: string;
  maxSize?: number;
}): Promise<string> {
  return invoke<string>("generate_thumbnail", {
    inputPath: params.inputPath,
    outputPath: params.outputPath,
    maxSize: params.maxSize ?? THUMB_MAX_SIZE,
  });
}

type ThumbnailTask = {
  dedupeKey: string;
  itemId?: string;
  inputPath: string;
  outputPath: string;
  maxSize?: number;
  timeoutMs?: number;
  maxRetries?: number;
  onSuccess?: (outputPath: string) => void;
  onError?: (error: unknown) => void;
};

type AsyncTask = {
  dedupeKey: string;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
};

const DEFAULT_THUMBNAIL_TIMEOUT_MS = 60_000;
const DEFAULT_THUMBNAIL_MAX_RETRIES = 1;
const DEFAULT_THUMBNAIL_QUEUE_START_DELAY_MS = 400;

class ThumbnailTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Thumbnail generation timed out after ${timeoutMs}ms`);
    this.name = "ThumbnailTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

type ThumbnailExecutionResult =
  | {
      ok: true;
      outputPath: string;
      durationMs: number;
      attempts: number;
      itemId: string;
    }
  | {
      ok: false;
      error: unknown;
      durationMs: number;
      attempts: number;
      itemId: string;
    };

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new ThumbnailTimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function formatErrorForLog(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class ThumbnailQueue {
  private readonly pendingByKey = new Map<string, ThumbnailTask>();
  private readonly activeKeys = new Set<string>();
  private activeCount = 0;
  private disposed = false;
  private delayedPumpTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly concurrency = 2,
    private readonly startDelayMs = DEFAULT_THUMBNAIL_QUEUE_START_DELAY_MS,
  ) {}

  enqueue(task: ThumbnailTask): void {
    if (this.disposed) {
      return;
    }

    if (this.activeKeys.has(task.dedupeKey) || this.pendingByKey.has(task.dedupeKey)) {
      return;
    }

    this.pendingByKey.set(task.dedupeKey, task);
    console.log("[thumb-queue] enqueue job", {
      itemId: task.itemId?.trim() || task.dedupeKey,
      queueLength: this.pendingByKey.size + this.activeCount,
    });
    this.schedulePump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.delayedPumpTimerId !== null) {
      clearTimeout(this.delayedPumpTimerId);
      this.delayedPumpTimerId = null;
    }
    this.pendingByKey.clear();
    this.activeKeys.clear();
  }

  private schedulePump(): void {
    if (this.disposed) {
      return;
    }

    if (this.startDelayMs <= 0 || this.activeCount > 0) {
      this.pump();
      return;
    }

    if (this.delayedPumpTimerId !== null) {
      clearTimeout(this.delayedPumpTimerId);
      this.delayedPumpTimerId = null;
    }

    this.delayedPumpTimerId = setTimeout(() => {
      this.delayedPumpTimerId = null;
      this.pump();
    }, this.startDelayMs);
  }

  private async runTask(task: ThumbnailTask): Promise<ThumbnailExecutionResult> {
    const itemId = task.itemId?.trim() || task.dedupeKey;
    const timeoutMs = normalizePositiveInt(task.timeoutMs, DEFAULT_THUMBNAIL_TIMEOUT_MS);
    const maxRetries = normalizeNonNegativeInt(task.maxRetries, DEFAULT_THUMBNAIL_MAX_RETRIES);
    const maxAttempts = maxRetries + 1;
    const startedAt = Date.now();

    console.log("[thumb-queue] start job", {
      itemId,
      vaultPath: task.inputPath,
      thumbPath: task.outputPath,
    });

    let lastError: unknown = new Error("Thumbnail job failed before running.");

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const outputPath = await withTimeout(
          generateThumbnail({
            inputPath: task.inputPath,
            outputPath: task.outputPath,
            maxSize: task.maxSize ?? THUMB_MAX_SIZE,
          }),
          timeoutMs,
        );
        const durationMs = Date.now() - startedAt;
        console.log("[thumb-queue] finish job", {
          itemId,
          status: "success",
          durationMs,
          attempts: attempt,
        });
        return { ok: true, outputPath, durationMs, attempts: attempt, itemId };
      } catch (error) {
        lastError = error;
        if (error instanceof ThumbnailTimeoutError) {
          console.error("[thumb-job] timeout", {
            itemId,
            timeoutMs,
            attempt,
            vaultPath: task.inputPath,
            thumbPath: task.outputPath,
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    console.error("[thumb-queue] finish job", {
      itemId,
      status: "error",
      durationMs,
      attempts: maxAttempts,
      error: formatErrorForLog(lastError),
    });
    return {
      ok: false,
      error: lastError,
      durationMs,
      attempts: maxAttempts,
      itemId,
    };
  }

  private pump(): void {
    if (this.disposed) {
      return;
    }

    if (this.pendingByKey.size > 0 || this.activeCount > 0) {
      console.log("[thumb-queue] pump tick", {
        queueLength: this.pendingByKey.size + this.activeCount,
        pending: this.pendingByKey.size,
        active: this.activeCount,
      });
    }

    while (this.activeCount < this.concurrency && this.pendingByKey.size > 0) {
      const nextEntry = this.pendingByKey.entries().next();
      if (nextEntry.done) {
        return;
      }

      const [dedupeKey, task] = nextEntry.value;
      this.pendingByKey.delete(dedupeKey);
      this.activeKeys.add(dedupeKey);
      this.activeCount += 1;

      void this.runTask(task)
        .then((result) => {
          if (this.disposed) {
            return;
          }
          if (result.ok) {
            task.onSuccess?.(result.outputPath);
          } else {
            task.onError?.(result.error);
          }
        })
        .catch((error) => {
          if (this.disposed) {
            return;
          }
          console.error("[thumb-queue] finish job", {
            itemId: task.itemId?.trim() || task.dedupeKey,
            status: "error",
            error: formatErrorForLog(error),
          });
          task.onError?.(error);
        })
        .finally(() => {
          if (!this.disposed) {
            this.activeKeys.delete(dedupeKey);
          }
          this.activeCount = Math.max(0, this.activeCount - 1);
          console.log("[thumb-queue] queue length", {
            queueLength: this.pendingByKey.size + this.activeCount,
          });
          this.pump();
        });
    }
  }
}

export class DedupeAsyncQueue {
  private readonly pendingByKey = new Map<string, AsyncTask>();
  private readonly activeKeys = new Set<string>();
  private activeCount = 0;
  private disposed = false;

  constructor(private readonly concurrency = 2) {}

  enqueue(task: AsyncTask): void {
    if (this.disposed) {
      return;
    }

    if (this.activeKeys.has(task.dedupeKey) || this.pendingByKey.has(task.dedupeKey)) {
      return;
    }

    this.pendingByKey.set(task.dedupeKey, task);
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingByKey.clear();
    this.activeKeys.clear();
  }

  private pump(): void {
    if (this.disposed) {
      return;
    }

    while (this.activeCount < this.concurrency && this.pendingByKey.size > 0) {
      const nextEntry = this.pendingByKey.entries().next();
      if (nextEntry.done) {
        return;
      }

      const [dedupeKey, task] = nextEntry.value;
      this.pendingByKey.delete(dedupeKey);
      this.activeKeys.add(dedupeKey);
      this.activeCount += 1;

      void Promise.resolve()
        .then(() => task.run())
        .catch((error) => {
          if (this.disposed) {
            return;
          }
          task.onError?.(error);
        })
        .finally(() => {
          if (!this.disposed) {
            this.activeKeys.delete(dedupeKey);
          }
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.pump();
        });
    }
  }
}
