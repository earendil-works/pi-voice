import {
  downloadFile,
  fileDownloadInfo,
  getHFHubCachePath,
  getRepoFolderName,
} from "@huggingface/hub";
import { createHash } from "node:crypto";
import {
  createReadStream,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { ReadableStream } from "node:stream/web";
import { ALL_MODELS } from "@handy-computer/models";
import { getCatalogModel, LANGUAGE_DETECTION_MODEL, modelFile, type CatalogModel } from "./catalog.js";
import { requiresLanguageDetector } from "./language-detection-policy.js";

function repositoryCacheDirectory(model: CatalogModel): string {
  return join(
    getHFHubCachePath(),
    getRepoFolderName({ name: model.repository, type: "model" }),
  );
}

/**
 * How a cached copy relates to the catalog: the pinned bytes, a revision the
 * catalog pinned before, or a snapshot it never shipped (another app's, or a
 * commit between pins). Every one is used; only a copy that fails to load is
 * set aside.
 */
export type CopyStatus = "current" | "outdated" | "unknown";

export type CachedCatalogModel = {
  path: string;
};

const STATUS_RANK: Record<CopyStatus, number> = { current: 0, outdated: 1, unknown: 2 };

/**
 * Copies that failed to load this session; the next pick downloads instead.
 * On globalThis because Pi loads extensions without a module cache, so the
 * lazy imports of this file can each get their own instance.
 */
const brokenCopies: Set<string> =
  ((globalThis as { [key: symbol]: Set<string> | undefined })[Symbol.for("pi-voice.brokenModelCopies")] ??= new Set());

function copyStatus(model: CatalogModel, revision: string, path: string): CopyStatus {
  if (revision === model.revision) return "current";
  try {
    // Snapshot files link to blobs named by their sha256, so a commit that
    // changed only the model card still holds the current bytes.
    if (basename(realpathSync(path)) === modelFile(model).sha256) return "current";
  } catch {
    // Not a link into blobs (a copied file); judge it by revision alone.
  }
  return model.previousRevisions.includes(revision) ? "outdated" : "unknown";
}

/** When the file was written, if it is a readable file. */
function fileWrittenAt(path: string): number | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.mtimeMs : undefined;
  } catch {
    // Missing, or a link whose blob is gone.
    return undefined;
  }
}

/**
 * Where a snapshot holds this file: at its catalog path, else anywhere in the
 * snapshot under the same name, since files move between folders across
 * revisions (multitalker went into bundle/ and is coming back out).
 */
function snapshotCopies(snapshot: string, filename: string): string[] {
  const exact = join(snapshot, filename);
  let others: string[] = [];
  try {
    others = readdirSync(snapshot, { recursive: true, encoding: "utf8" })
      .filter((entry) => basename(entry) === basename(filename))
      .map((entry) => join(snapshot, entry))
      .filter((path) => path !== exact);
  } catch {
    // An unreadable snapshot holds nothing usable.
  }
  return [exact, ...others];
}

/**
 * The best copy of this model in the standard Hugging Face cache, in any
 * snapshot: current bytes first, then the newest previous pin, then anything
 * else with the file's name.
 */
export function findCachedCatalogModel(model: CatalogModel): CachedCatalogModel | undefined {
  const { filename } = modelFile(model);
  const snapshots = join(repositoryCacheDirectory(model), "snapshots");
  let revisions: string[];
  try {
    revisions = readdirSync(snapshots);
  } catch {
    return undefined;
  }
  const found: { path: string; status: CopyStatus; order: number }[] = [];
  for (const revision of revisions) {
    const path = snapshotCopies(join(snapshots, revision), filename)
      .find((candidate) => !brokenCopies.has(candidate) && fileWrittenAt(candidate) !== undefined);
    const writtenAt = path && fileWrittenAt(path);
    if (!path || writtenAt === undefined) continue;
    const status = copyStatus(model, revision, path);
    const previous = model.previousRevisions.indexOf(revision);
    // Previous pins are newest first; other snapshots go newest-written first.
    const order = status === "outdated" ? previous : status === "unknown" ? -writtenAt : 0;
    found.push({ path, status, order });
  }
  found.sort((left, right) => STATUS_RANK[left.status] - STATUS_RANK[right.status] || left.order - right.order);
  const best = found[0];
  return best && { path: best.path };
}

/**
 * The catalog model and status of a cached copy, from its path, when the path
 * is a snapshot in the Hugging Face cache.
 */
export function cachedCopyAt(path: string): { model: CatalogModel; status: CopyStatus } | undefined {
  const parts = relative(getHFHubCachePath(), path).split(sep);
  const [folder, snapshots, revision] = parts;
  if (snapshots !== "snapshots" || !revision || parts.length < 4) return undefined;
  const id = ALL_MODELS.find(
    (model) => getRepoFolderName({ name: model.repository, type: "model" }) === folder,
  )?.id;
  const model = (id && getCatalogModel(id)) || (id === LANGUAGE_DETECTION_MODEL.id ? LANGUAGE_DETECTION_MODEL : undefined);
  return model && { model, status: copyStatus(model, revision, path) };
}

/**
 * Explain a load failure. A copy the catalog didn't pin may simply be too old
 * for this engine: set it aside so choosing the model again downloads the
 * current file, and say so. Failures of the current file are left alone; they
 * aren't the file's fault as far as anyone can tell.
 */
export function explainLoadFailure(path: string, error: unknown): unknown {
  const copy = cachedCopyAt(path);
  if (!copy || copy.status === "current") return error;
  brokenCopies.add(path);
  const message = error instanceof Error ? error.message : String(error);
  const which = copy.status === "outdated" ? "an older version" : "a version Pi Voice doesn't recognize";
  return new Error(
    `${message}. This copy of ${copy.model.name} is ${which}; ` +
      "run /voice-settings and choose it again to download the current one.",
    { cause: error },
  );
}

type DownloadProgress = {
  downloaded: number;
  total: number;
};

async function createCacheLink(blobPath: string, pointerPath: string): Promise<void> {
  await rm(pointerPath, { force: true });
  try {
    await symlink(relative(dirname(pointerPath), blobPath), pointerPath);
  } catch {
    // Match Hugging Face's Windows fallback when symlinks are unavailable.
    await copyFile(blobPath, pointerPath);
  }
}

export async function downloadCatalogModel(
  model: CatalogModel,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
    /** Overridable for tests; defaults to the global fetch. */
    fetch?: typeof fetch;
  } = {},
): Promise<string> {
  const { signal, onProgress } = options;
  const fetchImpl = options.fetch ?? fetch;
  signal?.throwIfAborted();

  const file = modelFile(model);
  const storage = repositoryCacheDirectory(model);
  const pointerPath = join(storage, "snapshots", model.revision, file.filename);
  if (await stat(pointerPath).then((value) => value.size === file.size, () => false)) {
    onProgress?.({ downloaded: file.size, total: file.size });
    return pointerPath;
  }

  const token = process.env.HF_TOKEN?.trim();
  const credentials = token ? { accessToken: token } : {};
  const abortingFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal });
  const info = await fileDownloadInfo({
    repo: model.repository,
    path: file.filename,
    revision: model.revision,
    fetch: abortingFetch,
    ...credentials,
  });
  if (!info) throw new Error(`Could not find ${file.filename} on Hugging Face`);
  if (info.size !== file.size) {
    throw new Error(
      `${model.name} size mismatch: catalog has ${file.size} bytes, Hugging Face reports ${info.size}`,
    );
  }

  // Match Hugging Face's standard cache key for these LFS-backed model files.
  const etag = info.etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const blobPath = join(storage, "blobs", etag);
  // The blob key names this exact content (the size was checked against the
  // catalog above), so a blob of any other size is a broken write by another
  // cache user and is replaced by a fresh download.
  const blobUsable = (): Promise<boolean> =>
    stat(blobPath).then((value) => value.size === file.size, () => false);
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  if (await blobUsable()) {
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: file.size, total: file.size });
    return pointerPath;
  }

  // A stable partial name lets a later attempt resume after cancellation or a
  // dropped connection. The picker serializes downloads; simultaneous writes
  // from separate processes are deliberately outside this best-effort design.
  const partialPath = `${blobPath}.incomplete`;

  const transfer = async (resume: boolean): Promise<void> => {
    const digest = createHash("sha256");
    let downloaded = 0;
    let body: ReadableStream<Uint8Array> | undefined;

    if (resume) {
      // Hash the saved prefix, then request and append only the remainder. A
      // full-size partial skips the payload request and goes to verification.
      for await (const chunk of createReadStream(partialPath)) {
        signal?.throwIfAborted();
        digest.update(chunk as Buffer);
        downloaded += (chunk as Buffer).length;
      }
      if (downloaded < file.size) {
        const response = await abortingFetch(info.url, {
          headers: {
            Range: `bytes=${downloaded}-`,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (response.status === 200 && response.body) {
          // The server ignored the range; discard the response and restart.
          await response.body.cancel().catch(() => undefined);
          await rm(partialPath, { force: true });
          return transfer(false);
        }
        if (response.status !== 206 || !response.body) {
          // Keep the saved prefix across transient server failures.
          await response.body?.cancel().catch(() => undefined);
          throw new Error(
            `Hugging Face returned HTTP ${response.status} while resuming ${model.name}`,
          );
        }
        const contentRange = response.headers.get("content-range");
        const range = contentRange?.match(/^bytes (\d+)-\d+\/(\d+)$/);
        if (!range || Number(range[1]) !== downloaded || Number(range[2]) !== file.size) {
          // Never append a response for different bytes.
          await response.body.cancel().catch(() => undefined);
          throw new Error(
            `Hugging Face returned an unexpected resume range (${contentRange ?? "missing"}) for ${model.name}`,
          );
        }
        body = response.body as unknown as ReadableStream<Uint8Array>;
      }
    } else {
      await rm(partialPath, { force: true });
      const blob = await downloadFile({
        repo: model.repository,
        path: file.filename,
        revision: model.revision,
        downloadInfo: info,
        fetch: abortingFetch,
        ...credentials,
      });
      if (!blob) throw new Error(`Could not download ${file.filename}`);
      body = blob.stream() as unknown as ReadableStream<Uint8Array>;
    }

    onProgress?.({ downloaded, total: file.size });
    if (body) {
      let lastReport = 0;
      const handle = await open(partialPath, resume ? "a" : "w");
      try {
        for await (const value of body) {
          signal?.throwIfAborted();
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          // Await each write so any later abort or stream error leaves a clean,
          // fully written prefix that can safely be resumed.
          await handle.writeFile(chunk);
          downloaded += chunk.length;
          digest.update(chunk);
          const now = Date.now();
          if (now - lastReport >= 100 || downloaded === file.size) {
            lastReport = now;
            onProgress?.({ downloaded, total: file.size });
          }
        }
      } finally {
        await handle.close();
      }
    }
    signal?.throwIfAborted();

    const written = await stat(partialPath);
    if (written.size < file.size) {
      throw new Error(`${model.name} download ended early; partial bytes were kept`);
    }
    if (written.size > file.size || digest.digest("hex") !== file.sha256) {
      await rm(partialPath, { force: true });
      throw new Error(`${model.name} verification failed; incomplete bytes were removed`);
    }
  };

  const partialBytes = await stat(partialPath).then((value) => value.size, () => 0);
  await transfer(partialBytes > 0 && partialBytes <= file.size);

  if (await blobUsable()) {
    await rm(partialPath, { force: true });
  } else {
    try {
      // rename() replaces a wrong-size blob left by an interrupted writer.
      await rename(partialPath, blobPath);
    } catch (error) {
      // Another process may have published the same verified blob first.
      if (!(await blobUsable())) throw error;
      await rm(partialPath, { force: true });
    }
  }
  await createCacheLink(blobPath, pointerPath);
  onProgress?.({ downloaded: file.size, total: file.size });
  return pointerPath;
}

/** A resumable partial download of this model on disk, if any. */
export function findIncompleteDownload(
  model: CatalogModel,
): { bytes: number } | undefined {
  const file = modelFile(model);
  // For these LFS-backed files the cache key (the server etag) is the content
  // sha256, so the catalog names the partial exactly; partials from other
  // revisions can never match. If the server ever reported a different etag,
  // this merely under-promises: the footer says "download", selecting still
  // resumes the server-etag partial.
  const partialPath = join(
    repositoryCacheDirectory(model),
    "blobs",
    `${file.sha256}.incomplete`,
  );
  try {
    const bytes = statSync(partialPath).size;
    if (bytes > 0 && bytes < file.size) return { bytes };
  } catch {
    // Missing file means no partial download.
  }
  return undefined;
}

/**
 * What choosing `model` still has to download: the model unless it is cached,
 * plus the shared language detector when the model relies on it and it is
 * not cached either.
 */
export function pendingDownloads(model: CatalogModel, modelCached: boolean): CatalogModel[] {
  const pending = modelCached ? [] : [model];
  if (requiresLanguageDetector(model) && !findCachedCatalogModel(LANGUAGE_DETECTION_MODEL)) {
    pending.push(LANGUAGE_DETECTION_MODEL);
  }
  return pending;
}
