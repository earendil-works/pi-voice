import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { getCatalogModel, modelFile, type CatalogModel } from "../src/catalog.js";
import { settingsForModel } from "../src/settings.js";
import { cachedCopyAt, explainLoadFailure, findCachedCatalogModel } from "../src/models.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { isolatedModelCache, snapshotPath } from "./model-cache-helper.js";

// Real catalog entries: multitalker's file moved into bundle/ between pins,
// and canary's pin moved once.
const multitalker = getCatalogModel("multitalker-parakeet-streaming-0.6b-v1")!;
const canary = getCatalogModel("canary-180m-flash")!;
const [newerPin, olderPin] = multitalker.previousRevisions as [string, string];
const NEVER_PINNED = "456e6049062ecf06f1a0f4607f2ee3dc80ebbf8a";

function write(path: string, mtime?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x");
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
  return path;
}

/** A snapshot file linked to a blob, as Hugging Face lays them out. */
function linkToBlob(model: CatalogModel, revision: string, sha256: string): string {
  const path = snapshotPath(model, revision);
  const blob = join(dirname(path), "..", "..", "blobs", sha256);
  write(blob);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(join("..", "..", "blobs", sha256), path);
  return path;
}

function cache(t: TestContext): void {
  isolatedModelCache(t);
}

test("the multitalker and canary entries still describe these cases", () => {
  assert.ok(modelFile(multitalker).filename.startsWith("bundle/"));
  assert.equal(multitalker.previousRevisions.length, 2);
  assert.equal(canary.previousRevisions.length, 1);
  assert.ok(![canary.revision, ...canary.previousRevisions].includes(NEVER_PINNED));
});

test("nothing cached, or a link whose blob is gone, is not a copy", (t) => {
  cache(t);
  assert.equal(findCachedCatalogModel(canary), undefined);
  const path = snapshotPath(canary);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync("../../blobs/missing", path);
  assert.equal(findCachedCatalogModel(canary), undefined);
});

test("the pinned file is found at any size", (t) => {
  cache(t);
  const path = write(snapshotPath(canary));
  assert.deepEqual(findCachedCatalogModel(canary), { path });
  assert.equal(cachedCopyAt(path)?.status, "current");
});

test("an older pin is found even where the file has since moved into a folder", (t) => {
  cache(t);
  const root = basename(modelFile(multitalker).filename);
  const path = write(snapshotPath(multitalker, olderPin, root));
  assert.deepEqual(findCachedCatalogModel(multitalker), { path });
  assert.equal(cachedCopyAt(path)?.status, "outdated");
});

test("a copy is found inside a folder the file has since left", (t) => {
  cache(t);
  // The next release moves multitalker's files back out of bundle/.
  const root = basename(modelFile(multitalker).filename);
  const next: CatalogModel = {
    ...multitalker,
    revision: "f".repeat(40),
    previousRevisions: [multitalker.revision, ...multitalker.previousRevisions],
    files: { ...multitalker.files, [multitalker.quant]: { ...modelFile(multitalker), filename: root } },
  };
  const path = write(snapshotPath(multitalker));
  assert.ok(path.endsWith(`/bundle/${root}`));
  assert.deepEqual(findCachedCatalogModel(next), { path });
});

test("copies rank current, then newest previous pin, then newest other snapshot", (t) => {
  cache(t);
  const root = basename(modelFile(multitalker).filename);
  const strangerOld = write(snapshotPath(multitalker, "a".repeat(40), root), 1_000);
  const strangerNew = write(snapshotPath(multitalker, "b".repeat(40), root), 2_000);
  assert.deepEqual(findCachedCatalogModel(multitalker), { path: strangerNew });
  assert.equal(cachedCopyAt(strangerOld)?.status, "unknown");

  const older = write(snapshotPath(multitalker, olderPin, root));
  assert.deepEqual(findCachedCatalogModel(multitalker), { path: older });
  const newer = write(snapshotPath(multitalker, newerPin));
  assert.deepEqual(findCachedCatalogModel(multitalker), { path: newer });
  const current = write(snapshotPath(multitalker));
  assert.deepEqual(findCachedCatalogModel(multitalker), { path: current });
});

test("an unpinned snapshot holding the current bytes counts as current", (t) => {
  cache(t);
  // The real canary cache: an old pin and a never-pinned commit both on disk.
  const old = linkToBlob(canary, canary.previousRevisions[0]!, "e".repeat(64));
  assert.deepEqual(findCachedCatalogModel(canary), { path: old });
  const same = linkToBlob(canary, NEVER_PINNED, modelFile(canary).sha256);
  assert.deepEqual(findCachedCatalogModel(canary), { path: same });
  assert.equal(cachedCopyAt(same)?.status, "current");
  assert.equal(cachedCopyAt(old)?.status, "outdated");
});

test("a copy outside the cache, or of another repository, is not described", (t) => {
  cache(t);
  assert.equal(cachedCopyAt("/models/canary-180m-flash-Q8_0.gguf"), undefined);
  assert.equal(cachedCopyAt(join(process.env.HF_HUB_CACHE!, "models--someone--else", "snapshots", "abc", "m.gguf")), undefined);
});

test("an older copy that fails to load is set aside with directions", (t) => {
  cache(t);
  const old = write(snapshotPath(canary, canary.previousRevisions[0]));
  const original = new Error("unsupported tensor type");
  const explained = explainLoadFailure(old, original) as Error;
  assert.match(explained.message, /^unsupported tensor type\. This copy of Canary .* is an older version; run \/voice-settings/);
  assert.equal(explained.cause, original);
  // Choosing the model again now finds nothing, so it downloads.
  assert.equal(findCachedCatalogModel(canary), undefined);
});

test("the current file failing to load is not blamed on the file", (t) => {
  cache(t);
  const path = write(snapshotPath(canary));
  const original = new Error("out of memory");
  assert.equal(explainLoadFailure(path, original), original);
  assert.deepEqual(findCachedCatalogModel(canary), { path });
});

test("a dictation whose older copy fails to load reports why", async (t) => {
  cache(t);
  const root = basename(modelFile(multitalker).filename);
  const path = write(snapshotPath(multitalker, olderPin, root));
  const service = new TranscriptionService(async () => ({
    async prepare() { throw new Error("bad model"); },
    async transcribe() { throw new Error("never"); },
    async dispose() {},
  }));
  await assert.rejects(
    service.transcribeFile(settingsForModel(multitalker.id, path), new Float32Array(16_000)),
    /bad model\. This copy of .* is an older version/);
  assert.equal(findCachedCatalogModel(multitalker), undefined);
  await service.shutdown();
});
