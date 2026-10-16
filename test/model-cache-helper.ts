import { getRepoFolderName } from "@huggingface/hub";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { modelFile, type CatalogModel } from "../src/catalog.js";

/** Small, isolated cache entries; never touch real models or download files. */
export function isolatedModelCache(t: TestContext): (model: CatalogModel) => CatalogModel {
  const previous = process.env.HF_HUB_CACHE;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-cache-test-"));
  process.env.HF_HUB_CACHE = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return (model) => {
    const path = snapshotPath(model);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
    return model;
  };
}

/** Where the pinned file of `model` lives in the active test cache. */
export function snapshotPath(model: CatalogModel, revision = model.revision, filename = modelFile(model).filename): string {
  return join(
    process.env.HF_HUB_CACHE!,
    getRepoFolderName({ name: model.repository, type: "model" }),
    "snapshots",
    revision,
    filename,
  );
}

/** A sparse cache entry at the catalog size, visible to production cache probes. */
export function cacheCatalogModel(
  cache: (model: CatalogModel) => CatalogModel,
  model: CatalogModel,
): CatalogModel {
  cache(model);
  truncateSync(snapshotPath(model), modelFile(model).size);
  return model;
}
