import { test } from "node:test";
import assert from "node:assert/strict";
import { getRepoFolderName } from "@huggingface/hub";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFile, type CatalogModel } from "../src/catalog.js";
import { downloadCatalogModel, findIncompleteDownload } from "../src/models.js";

const CHUNK = 16384;

function testData(length: number): Buffer {
  const data = Buffer.alloc(length);
  let seed = 42;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    data[index] = seed & 0xff;
  }
  return data;
}

function testModel(data: Buffer): CatalogModel {
  return {
    id: "test-model",
    name: "Test Model",
    repository: "test-org/test-model-gguf",
    revision: "0123456789abcdef",
    previousRevisions: [],
    quant: "Q8_0",
    files: { Q8_0: { filename: "model.gguf", size: data.length, sha256: createHash("sha256").update(data).digest("hex") } },
  } as unknown as CatalogModel;
}

/**
 * A fake Hugging Face endpoint with real Range semantics: 206 with a
 * content-range for the fileDownloadInfo probe and honored range requests,
 * 200 with the full payload otherwise.
 */
function fakeHub(options: {
  data: Buffer;
  honorRanges?: boolean;
  /** Error the stream once after serving this many payload bytes. */
  failAfter?: number;
  /** End the stream cleanly after serving this many payload bytes. */
  endAfter?: number;
  /** Observe cumulative payload bytes; used to abort deterministically. */
  onServed?: (total: number) => void;
  /** Respond to resume range requests with this HTTP status and no body. */
  resumeStatus?: number;
  /** Lie about the starting offset in the 206 Content-Range header. */
  wrongRangeStart?: boolean;
}) {
  // Like real Hugging Face LFS files, the etag is the content sha256.
  const etag = createHash("sha256").update(options.data).digest("hex");
  const requests: (string | null)[] = [];
  let served = 0;
  let failAfter = options.failAfter;

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const range = new Headers(init?.headers).get("range");
    requests.push(range);
    void input;
    if (range === "bytes=0-0") {
      return new Response(options.data.subarray(0, 1), {
        status: 206,
        headers: {
          "content-range": `bytes 0-0/${options.data.length}`,
          etag: `"${etag}"`,
        },
      });
    }

    const match = range?.match(/^bytes=(\d+)-$/);
    if (match && options.resumeStatus !== undefined) {
      return new Response(null, { status: options.resumeStatus });
    }
    const honored = Boolean(match) && options.honorRanges !== false;
    const start = honored ? Number(match![1]) : 0;
    const payload = options.data.subarray(start);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (failAfter !== undefined && served >= failAfter) {
          failAfter = undefined;
          controller.error(new Error("connection reset"));
          return;
        }
        if (options.endAfter !== undefined && served >= options.endAfter) {
          controller.close();
          return;
        }
        if (offset >= payload.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + CHUNK, payload.length);
        controller.enqueue(new Uint8Array(payload.subarray(offset, end)));
        served += end - offset;
        offset = end;
        options.onServed?.(served);
      },
    });
    return new Response(body, {
      status: honored ? 206 : 200,
      headers: honored
        ? {
            "content-range": `bytes ${start + (options.wrongRangeStart ? 1 : 0)}-${options.data.length - 1}/${options.data.length}`,
            etag: `"${etag}"`,
          }
        : { etag: `"${etag}"` },
    });
  }) as typeof fetch;

  return { fetchImpl, requests, bytesServed: () => served };
}

async function withCacheDirectory(run: () => Promise<void>): Promise<void> {
  const previous = process.env.HF_HUB_CACHE;
  const cacheDirectory = await mkdtemp(join(tmpdir(), "pi-voice-models-"));
  process.env.HF_HUB_CACHE = cacheDirectory;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HF_HUB_CACHE;
    else process.env.HF_HUB_CACHE = previous;
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

function blobsDirectory(model: CatalogModel): string {
  return join(
    process.env.HF_HUB_CACHE!,
    getRepoFolderName({ name: model.repository, type: "model" }),
    "blobs",
  );
}

test("an interrupted download keeps a resumable partial and resumes with a range request", () =>
  withCacheDirectory(async () => {
    const data = testData(512 * 1024);
    const model = testModel(data);

    // Abort mid-transfer, deterministically, once ~40% has been served.
    const controller = new AbortController();
    const first = fakeHub({
      data,
      onServed: (total) => {
        if (total >= 200_000) controller.abort();
      },
    });
    await assert.rejects(
      downloadCatalogModel(model, { signal: controller.signal, fetch: first.fetchImpl }),
    );

    const partial = findIncompleteDownload(model);
    assert.ok(partial, "expected a kept partial download");
    assert.ok(partial.bytes > 0 && partial.bytes < data.length, `partial: ${partial.bytes}`);

    // The second attempt asks only for the remainder and completes the file.
    const second = fakeHub({ data });
    const path = await downloadCatalogModel(model, { fetch: second.fetchImpl });
    assert.ok(second.requests.includes(`bytes=${partial.bytes}-`), `requests: ${second.requests}`);
    assert.equal(second.bytesServed(), data.length - partial.bytes);
    const downloaded = await readFile(path);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), modelFile(model).sha256);
    assert.equal(findIncompleteDownload(model), undefined);
  }));

test("an early EOF keeps the partial for the next attempt", () =>
  withCacheDirectory(async () => {
    const data = testData(256 * 1024);
    const model = testModel(data);

    const truncated = fakeHub({ data, endAfter: 100_000 });
    await assert.rejects(
      downloadCatalogModel(model, { fetch: truncated.fetchImpl }),
      /ended early/,
    );
    const partial = findIncompleteDownload(model);
    assert.ok(partial && partial.bytes > 0);

    const path = await downloadCatalogModel(model, { fetch: fakeHub({ data }).fetchImpl });
    assert.equal((await stat(path)).size, data.length);
  }));

test("a server that ignores ranges restarts the download cleanly", () =>
  withCacheDirectory(async () => {
    const data = testData(256 * 1024);
    const model = testModel(data);
    await mkdir(blobsDirectory(model), { recursive: true });
    await writeFile(join(blobsDirectory(model), `${modelFile(model).sha256}.incomplete`), Buffer.alloc(100_000, 7));

    const hub = fakeHub({ data, honorRanges: false });
    const path = await downloadCatalogModel(model, { fetch: hub.fetchImpl });
    // The range was attempted, ignored, and the transfer started over.
    assert.ok(hub.requests.includes("bytes=100000-"));
    // The cancelled 200 response may have one eagerly pulled chunk on top of
    // the clean restart.
    assert.ok(hub.bytesServed() >= data.length && hub.bytesServed() <= data.length + CHUNK);
    const downloaded = await readFile(path);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), modelFile(model).sha256);
  }));

test("a corrupted partial fails verification, is removed, and the retry succeeds", () =>
  withCacheDirectory(async () => {
    const data = testData(256 * 1024);
    const model = testModel(data);
    await mkdir(blobsDirectory(model), { recursive: true });
    // Plausible size, wrong content: the resumed hash cannot match.
    await writeFile(join(blobsDirectory(model), `${modelFile(model).sha256}.incomplete`), Buffer.alloc(100_000, 7));

    await assert.rejects(
      downloadCatalogModel(model, { fetch: fakeHub({ data }).fetchImpl }),
      /verification failed/,
    );
    assert.equal(findIncompleteDownload(model), undefined);

    const path = await downloadCatalogModel(model, { fetch: fakeHub({ data }).fetchImpl });
    assert.equal((await stat(path)).size, data.length);
  }));

test("a full-size partial is verified and published without touching the network", () =>
  withCacheDirectory(async () => {
    const data = testData(128 * 1024);
    const model = testModel(data);
    await mkdir(blobsDirectory(model), { recursive: true });
    await writeFile(join(blobsDirectory(model), `${modelFile(model).sha256}.incomplete`), data);

    const hub = fakeHub({ data });
    const path = await downloadCatalogModel(model, { fetch: hub.fetchImpl });
    // Only the fileDownloadInfo probe went out; the payload came from disk.
    assert.equal(hub.bytesServed(), 0);
    assert.equal((await stat(path)).size, data.length);
    assert.equal(findIncompleteDownload(model), undefined);
  }));

test("a transient error while resuming preserves the partial", () =>
  withCacheDirectory(async () => {
    const data = testData(256 * 1024);
    const model = testModel(data);
    const flaky = fakeHub({ data, failAfter: 100_000 });
    await assert.rejects(downloadCatalogModel(model, { fetch: flaky.fetchImpl }));
    const partial = findIncompleteDownload(model);
    assert.ok(partial && partial.bytes > 0);

    // A 500 on the resume request keeps every saved byte.
    await assert.rejects(
      downloadCatalogModel(model, { fetch: fakeHub({ data, resumeStatus: 500 }).fetchImpl }),
      /HTTP 500/,
    );
    assert.deepEqual(findIncompleteDownload(model), partial);

    const hub = fakeHub({ data });
    const path = await downloadCatalogModel(model, { fetch: hub.fetchImpl });
    assert.ok(hub.requests.includes(`bytes=${partial!.bytes}-`));
    assert.equal((await stat(path)).size, data.length);
  }));

test("a 206 with the wrong starting offset is rejected without changing the partial", () =>
  withCacheDirectory(async () => {
    const data = testData(256 * 1024);
    const model = testModel(data);
    await mkdir(blobsDirectory(model), { recursive: true });
    await writeFile(
      join(blobsDirectory(model), `${modelFile(model).sha256}.incomplete`),
      data.subarray(0, 100_000),
    );

    await assert.rejects(
      downloadCatalogModel(model, { fetch: fakeHub({ data, wrongRangeStart: true }).fetchImpl }),
      /unexpected resume range/,
    );
    assert.equal(findIncompleteDownload(model)?.bytes, 100_000);
  }));
