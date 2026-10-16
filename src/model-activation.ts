import { LANGUAGE_DETECTION_MODEL, displayLanguage, modelFile, type CatalogModel } from "./catalog.js";
import { settingsLanguagePolicy } from "./language-detection-policy.js";
import { describeError, log } from "./log.js";
import { downloadCatalogModel, findCachedCatalogModel, pendingDownloads, type CachedCatalogModel } from "./models.js";
import { writeSettings, type TranscribeSettings } from "./settings.js";

export type ActivationProgress = { downloaded: number; total: number; message?: string };

export type CatalogModelActivation = (
  model: CatalogModel,
  options: {
    cached: CachedCatalogModel | undefined;
    signal: AbortSignal;
    onProgress: (progress: ActivationProgress) => void;
  },
) => Promise<{ path: string }>;

/**
 * The download-then-save pipeline behind the model picker, shared by
 * onboarding and the settings menu. Back-to-back selections can outrun their
 * settings writes; commits run in selection order, so the file always ends on
 * the user's last choice.
 */
export function createModelActivation(options: {
  buildSettings: (model: CatalogModel, path: string) => TranscribeSettings;
  onCommitted: (settings: TranscribeSettings) => void;
  onWarning: (message: string) => void;
}): {
  activate: CatalogModelActivation;
  /** Resolves once every commit enqueued so far has landed (or failed). */
  waitForCommits: () => Promise<void>;
} {
  let commitQueue: Promise<void> = Promise.resolve();

  const activate: CatalogModelActivation = async (
    model,
    { cached, signal, onProgress },
  ) => {
    let path: string;
    let detectorFailed = false;
    const pending = pendingDownloads(model, Boolean(cached));
    const detectorMissing = pending.includes(LANGUAGE_DETECTION_MODEL);
    const asrBytes = cached ? 0 : modelFile(model).size;
    const total = pending.reduce((sum, item) => sum + modelFile(item).size, 0);
    if (cached) {
      // The picker listed the cache when it opened; re-check so settings
      // never point at a file that has since been evicted. Integrity is
      // covered by the download-time hash and the size check here.
      const stillCached = findCachedCatalogModel(model);
      if (!stillCached) {
        throw new Error(
          "the downloaded file is missing; select the model again to re-download it",
        );
      }
      path = stillCached.path;
    } else {
      path = await downloadCatalogModel(model, {
        signal,
        onProgress: (progress) => onProgress({ ...progress, total }),
      });
    }

    if (detectorMissing) {
      try {
        onProgress({ downloaded: asrBytes, total, message: "Downloading language detector…" });
        await downloadCatalogModel(LANGUAGE_DETECTION_MODEL, {
          signal,
          onProgress: (progress) => onProgress({
            downloaded: asrBytes + progress.downloaded, total,
            message: "Downloading language detector…",
          }),
        });
      } catch (error) {
        // Cancellation is never a settings commit. Other failures still
        // select the model: without the detector, Auto falls back to the
        // first preferred language, and the first take says how to fix it.
        signal.throwIfAborted();
        log.warn(`Language detector download failed: ${describeError(error)}`);
        detectorFailed = true;
      }
    }

    let committed: TranscribeSettings | undefined;
    const commit = commitQueue.then(async () => {
      // Skip the write when this selection was superseded or its download
      // was cancelled while the commit sat in the queue.
      signal.throwIfAborted();
      let settings: TranscribeSettings;
      try {
        settings = options.buildSettings(model, path);
        await writeSettings(settings);
      } catch (error) {
        throw new Error(
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      committed = settings;
      options.onCommitted(settings);
    });
    commitQueue = commit.then(
      () => undefined,
      () => undefined,
    );
    await commit;
    // Only Auto detect uses the detector, so other settings need no warning.
    const policy = committed && settingsLanguagePolicy(committed);
    if (detectorFailed && policy?.kind === "detect") {
      try {
        options.onWarning(
          `Selected ${model.name}, but the language detector didn't download. ` +
          `Auto detect will use ${displayLanguage(policy.languages[0]!)} until it does. ` +
          "To retry the download, choose Auto detect in /voice-settings.",
        );
      } catch { /* Notification is not part of the save. */ }
    }
    return { path };
  };

  return { activate, waitForCommits: () => commitQueue };
}
