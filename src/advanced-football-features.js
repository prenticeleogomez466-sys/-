const ADVANCED_DATA_LAYERS = [
  { key: "elo", label: "Elo/球队强度", env: "TEAM_ELO_SOURCE_URL", requiredForTopTier: true },
  { key: "form", label: "近期状态/赛程强度", env: "TEAM_FORM_SOURCE_URL", requiredForTopTier: true },
  { key: "injuries", label: "伤停与阵容", env: "INJURY_SOURCE_URL", requiredForTopTier: true },
  { key: "lineups", label: "预计首发", env: "LINEUP_SOURCE_URL", requiredForTopTier: true },
  { key: "xg", label: "xG/射门质量", env: "XG_SOURCE_URL", requiredForTopTier: true },
  { key: "weather", label: "天气/场地/旅行", env: "WEATHER_SOURCE_URL", requiredForTopTier: false },
  { key: "news", label: "新闻舆情/战意", env: "NEWS_SOURCE_URL", requiredForTopTier: false }
];

export function buildAdvancedFixtureFeatures(fixture, snapshot = null, probabilities = {}, options = {}) {
  const env = options.env ?? process.env;
  const market = buildMarketMicrostructure(snapshot, probabilities);
  const external = buildExternalDataAvailability(env, fixture, options.advancedData);
  const riskTags = buildRiskTags(market, external, probabilities);
  return {
    version: "top-tier-gap-v1",
    market,
    external,
    riskTags,
    quality: buildQualityScore(market, external, riskTags)
  };
}

export function advancedDataLayerStatus(env = process.env, advancedData = null) {
  return ADVANCED_DATA_LAYERS.map((layer) => ({
    ...layer,
    configured: Boolean(env[layer.env]) || layerAvailableFromSync(advancedData, layer.key),
    source: env[layer.env] ? "env" : layerAvailableFromSync(advancedData, layer.key) ? "synced" : "",
    count: advancedData?.layers?.[layer.key]?.count ?? 0,
    status: Boolean(env[layer.env]) || layerAvailableFromSync(advancedData, layer.key) ? "configured" : layer.requiredForTopTier ? "missing-required" : "missing-optional"
  }));
}

export function topTierReadiness(featuresOrRows) {
  const rows = Array.isArray(featuresOrRows) ? featuresOrRows : featuresOrRows?.external?.layers ?? [];
  const required = rows.filter((row) => row.requiredForTopTier);
  const configuredRequired = required.filter((row) => row.configured).length;
  const readiness = required.length ? configuredRequired / required.length : 0;
  return {
    ready: readiness >= 1,
    readiness: round(readiness),
    configuredRequired,
    required: required.length,
    missingRequired: required.filter((row) => !row.configured).map((row) => row.label)
  };
}

function buildMarketMicrostructure(snapshot, probabilities) {
  const initial = snapshot?.europeanOdds?.initial ?? null;
  const current = snapshot?.europeanOdds?.current ?? snapshot?.europeanOdds?.final ?? null;
  const initialImplied = initial ? impliedProbabilities(initial) : null;
  const currentImplied = current ? impliedProbabilities(current) : probabilities || null;
  const asianInitial = snapshot?.asianHandicap?.initial ?? null;
  const asianCurrent = snapshot?.asianHandicap?.current ?? snapshot?.asianHandicap?.final ?? null;
  const movement = initialImplied && currentImplied ? probabilityMovement(initialImplied, currentImplied) : null;
  return {
    hasEuropeanOdds: Boolean(current),
    hasAsianHandicap: Boolean(asianCurrent),
    hasHandicapOdds: Boolean(snapshot?.handicapOdds?.current || snapshot?.handicapOdds?.final),
    hasScoreOdds: Boolean(snapshot?.scoreOdds?.top?.length),
    hasHalfFullOdds: Boolean(snapshot?.halfFullOdds?.top?.length),
    overround: current ? overround(current) : null,
    entropy: currentImplied ? entropy(currentImplied) : null,
    favorite: currentImplied ? favoriteOutcome(currentImplied) : null,
    probabilityMovement: movement,
    asianLine: asianCurrent?.line ?? null,
    asianLineMovement: asianInitial && asianCurrent ? round(asianCurrent.line - asianInitial.line) : null,
    asianWaterSkew: asianCurrent ? round((asianCurrent.homeWater ?? 0) - (asianCurrent.awayWater ?? 0)) : null,
    source: snapshot?.source ?? "",
    collectedAt: snapshot?.collectedAt ?? null
  };
}

function buildExternalDataAvailability(env, fixture, advancedData) {
  const fixtureData = advancedFixtureData(advancedData, fixture);
  const layers = advancedDataLayerStatus(env, advancedData).map((layer) => {
    const hasEnvironmentSource = Boolean(env[layer.env]);
    const hasFixtureData = fixtureLayerAvailable(fixtureData, layer.key);
    return {
      ...layer,
      configured: hasEnvironmentSource || hasFixtureData,
      source: hasEnvironmentSource ? "env" : hasFixtureData ? "synced-fixture" : "",
      fixtureCovered: hasFixtureData,
      status: hasEnvironmentSource || hasFixtureData ? "configured" : layer.requiredForTopTier ? "missing-required" : "missing-optional"
    };
  });
  return {
    layers,
    readiness: topTierReadiness(layers),
    fixtureData
  };
}

function advancedFixtureData(advancedData, fixture) {
  if (!advancedData || !fixture) return {};
  return advancedData.fixtures?.find((row) => row.fixtureId === fixture.id)?.data ?? {};
}

function layerAvailableFromSync(advancedData, key) {
  const layer = advancedData?.layers?.[key];
  return Boolean(layer?.ok && layer.count > 0);
}

function fixtureLayerAvailable(fixtureData, key) {
  const value = fixtureData?.[key];
  if (!value) return false;
  if (key === "elo") return Boolean(value.home && value.away);
  if (key === "form") return Boolean((value.home?.matches ?? 0) > 0 && (value.away?.matches ?? 0) > 0);
  if (key === "weather") return Boolean(value.hourly && Object.keys(value.hourly).length > 0);
  if (key === "news") return Boolean(value.articles?.length);
  return Object.keys(value).length > 0;
}

function buildRiskTags(market, external, probabilities) {
  const tags = [];
  const gap = favoriteGap(probabilities);
  if (!market.hasEuropeanOdds) tags.push("missing-european-odds");
  if (!market.hasAsianHandicap) tags.push("missing-asian-handicap");
  if (!market.hasScoreOdds) tags.push("score-derived-without-market-odds");
  if (!market.hasHalfFullOdds) tags.push("half-full-derived-without-market-odds");
  if (market.overround !== null && market.overround > 0.12) tags.push("high-bookmaker-margin");
  if (market.probabilityMovement !== null && market.probabilityMovement.maxAbsShift >= 0.07) tags.push("large-odds-drift");
  if (market.asianLineMovement !== null && Math.abs(market.asianLineMovement) >= 0.5) tags.push("large-asian-line-move");
  if (gap !== null && gap < 0.08) tags.push("low-probability-separation");
  if (!external.readiness.ready) tags.push("missing-top-tier-team-intelligence");
  return tags;
}

function buildQualityScore(market, external, riskTags) {
  let score = 100;
  if (!market.hasEuropeanOdds) score -= 25;
  if (!market.hasAsianHandicap) score -= 20;
  if (!market.hasHandicapOdds) score -= 8;
  if (!market.hasScoreOdds) score -= 6;
  if (!market.hasHalfFullOdds) score -= 6;
  score -= Math.round((1 - external.readiness.readiness) * 20);
  score -= riskTags.filter((tag) => tag.includes("large") || tag.includes("high") || tag.includes("low")).length * 5;
  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    grade: bounded >= 88 ? "A" : bounded >= 76 ? "B" : bounded >= 62 ? "C" : "D",
    topTierReady: external.readiness.ready && bounded >= 88
  };
}

function impliedProbabilities(odds) {
  const raw = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const total = raw.home + raw.draw + raw.away;
  return { home: round(raw.home / total), draw: round(raw.draw / total), away: round(raw.away / total) };
}

function overround(odds) {
  return round((1 / odds.home) + (1 / odds.draw) + (1 / odds.away) - 1);
}

function entropy(probabilities) {
  const values = ["home", "draw", "away"].map((key) => probabilities[key]).filter((value) => value > 0);
  return round(-values.reduce((sum, value) => sum + value * Math.log2(value), 0));
}

function favoriteOutcome(probabilities) {
  return ["home", "draw", "away"]
    .map((key) => ({ key, probability: probabilities[key] ?? 0 }))
    .sort((left, right) => right.probability - left.probability)[0];
}

function probabilityMovement(initial, current) {
  const shifts = ["home", "draw", "away"].map((key) => ({ key, shift: round((current[key] ?? 0) - (initial[key] ?? 0)) }));
  return {
    shifts,
    maxAbsShift: Math.max(...shifts.map((item) => Math.abs(item.shift)))
  };
}

function favoriteGap(probabilities) {
  const values = ["home", "draw", "away"].map((key) => probabilities[key]).filter(Number.isFinite).sort((left, right) => right - left);
  return values.length >= 2 ? round(values[0] - values[1]) : null;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
