import {
  CURATED_MODELS,
  getModel,
  LANGUAGE_DETECTION_MODEL as DETECTOR,
  type CatalogModel,
} from "@handy-computer/models";

export type { CatalogModel, ModelFile } from "@handy-computer/models";
export {
  canonicalLanguage,
  catalogModelSearchText,
  displayLanguage,
  formatBinarySize,
  languageIdentity,
  modelFile,
  modelMatchesLanguage,
  rankCatalogModels,
  resolveModelLanguage,
} from "@handy-computer/models";

/** What the pickers show and recommend from. */
export const CATALOG_MODELS: readonly CatalogModel[] = CURATED_MODELS;

/** Language detection model for transcription models without native
 * language detection. */
export const LANGUAGE_DETECTION_MODEL: CatalogModel = DETECTOR;

/**
 * A transcription model by id. Published models resolve too, so a saved
 * setting keeps working after its model leaves the curated list; other roles
 * (VAD, diarizer, language detector) never do.
 */
export function getCatalogModel(id: string): CatalogModel | undefined {
  const model = getModel(id);
  return model?.role === "asr" ? model : undefined;
}
