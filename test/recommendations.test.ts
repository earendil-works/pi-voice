import assert from "node:assert/strict";
import { test } from "node:test";
import { catalog } from "@handy-computer/models";
import { CATALOG_MODELS, languageIdentity } from "../src/catalog.js";
import { hasRecommendedAlternatives } from "../src/recommendation-picker.js";
import {
  EXPERIMENTAL_MAX_ERROR_PERCENT,
  getPreferredRecommendationLanguages,
  recommendModels,
  type ModelRecommendation,
} from "../src/recommendations.js";

const ALL_ROLES = ["accurate", "best", "fast"];
const languages = [
  ...new Set(CATALOG_MODELS.flatMap((model) => model.languages.map(languageIdentity))),
];

test("every role is assigned and usable models never mix with fallback alternatives", () => {
  for (const language of languages) {
    for (const wanted of [[language], ["en", language]]) {
      const picks = recommendModels(CATALOG_MODELS, wanted);
      assert.deepEqual(
        picks.flatMap((pick) => pick.roles).sort(),
        ALL_ROLES,
        wanted.join("+"),
      );
      if (picks.some((pick) => pick.status === "eligible")) {
        assert.ok(picks.every((pick) => pick.status === "eligible" && !pick.overFloor));
        assert.ok(
          picks.every(
            (pick) => pick.worstError! < catalog.methodology.maxLanguageErrorPercent,
          ),
        );
      } else {
        assert.equal(picks.length, 1, "fallbacks carry all roles");
      }
    }
  }
});

test("language aliases produce identical recommendations", () => {
  for (const [alias, canonical] of [["tl", "fil"], ["no", "nb"]] as const) {
    assert.deepEqual(
      recommendModels(CATALOG_MODELS, ["en", alias]),
      recommendModels(CATALOG_MODELS, ["en", canonical]),
    );
  }
});

test("fallback statuses and preferred-language visibility follow the methodology", () => {
  const models = catalog.data.results;
  const preferred = new Set(getPreferredRecommendationLanguages(CATALOG_MODELS));
  for (const language of languages) {
    const pick = recommendModels(CATALOG_MODELS, [language])[0]!;
    if (pick.error === undefined) assert.equal(pick.status, "unbenchmarked");
    else if (pick.overFloor) {
      const lower = models[pick.model.id]?.accuracy[pick.worstLanguage!]?.ciLower;
      const experimental = pick.worstError! < EXPERIMENTAL_MAX_ERROR_PERCENT ||
        (lower !== undefined && lower <= EXPERIMENTAL_MAX_ERROR_PERCENT);
      assert.equal(pick.status, experimental ? "experimental" : "unsupported");
    }
    assert.equal(
      preferred.has(language),
      ["eligible", "experimental"].includes(pick.status),
    );
  }

  const unmeasured = { ...CATALOG_MODELS[0]!, id: "unmeasured" };
  assert.equal(recommendModels([unmeasured], ["en"])[0]?.status, "unbenchmarked");
  assert.deepEqual(recommendModels([], ["en"]), []);
});

const fixtureRecommendations: ModelRecommendation[] = ["Balanced", "Quick", "Precise"].map(
  (name, index) => ({
    model: {
      ...CATALOG_MODELS[0]!,
      id: `test-${name}`,
      name,
      languages: ["en", "zh"],
      capabilities: { ...CATALOG_MODELS[0]!.capabilities, languageDetection: true },
    },
    roles: [(["best", "fast", "accurate"] as const)[index]!],
    status: "eligible",
  }),
);

test("alternatives are only offered when a non-primary pick is eligible", () => {
  assert.equal(hasRecommendedAlternatives(fixtureRecommendations), true);
  assert.equal(hasRecommendedAlternatives([fixtureRecommendations[0]!]), false);
});
