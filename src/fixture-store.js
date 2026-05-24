import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataSubdir } from "./paths.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const fixtureDir = getDataSubdir("fixtures");

export function loadFixtures(date = todayIso()) {
  ensureFixtureDir();
  const normalizedDate = safeDate(date);
  const filePath = join(fixtureDir, `${normalizedDate}.json`);
  if (!existsSync(filePath)) return { date: normalizedDate, source: "empty", importedAt: null, fixtures: [] };
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  const fixtures = Array.isArray(payload) ? payload : payload.fixtures ?? [];
  return {
    date: safeDate(payload.date ?? normalizedDate),
    source: payload.source ?? "fixture-json",
    importedAt: payload.importedAt ?? null,
    fixtures: fixtures.map((fixture, index) => normalizeFixture(fixture, normalizedDate, index))
  };
}

export function saveFixtures(date, fixtures, metadata = {}) {
  ensureFixtureDir();
  const normalizedDate = safeDate(date);
  const payload = {
    date: normalizedDate,
    source: metadata.source ?? "manual",
    importedAt: new Date().toISOString(),
    fixtures: fixtures.map((fixture, index) => normalizeFixture(fixture, normalizedDate, index))
  };
  writeFileSync(join(fixtureDir, `${normalizedDate}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function listFixtureDates() {
  ensureFixtureDir();
  return readdirSync(fixtureDir).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort().reverse();
}

export function normalizeFixture(fixture = {}, fallbackDate = todayIso(), index = 0) {
  const date = safeDate(fixture.date ?? fallbackDate);
  const homeTeam = String(fixture.homeTeam ?? fixture.home ?? fixture.host ?? "").trim();
  const awayTeam = String(fixture.awayTeam ?? fixture.away ?? fixture.guest ?? "").trim();
  if (!homeTeam || !awayTeam) throw new Error(`第 ${index + 1} 场缺少主队或客队`);
  return {
    id: fixture.id ?? fixture.fixtureId ?? makeFixtureId(date, homeTeam, awayTeam, index),
    date,
    kickoff: fixture.kickoff ?? fixture.time ?? "",
    competition: fixture.competition ?? fixture.league ?? "未知赛事",
    homeTeam,
    awayTeam,
    round: fixture.round ?? "",
    marketType: fixture.marketType ?? fixture.type ?? "daily",
    sequence: fixture.sequence ?? fixture.no ?? index + 1,
    tags: Array.isArray(fixture.tags) ? fixture.tags : [],
    notes: fixture.notes ?? "",
    source: fixture.source ?? "",
    officialStatus: fixture.officialStatus ?? "",
    officialFixtureId: fixture.officialFixtureId ?? null,
    result: normalizeResult(fixture.result)
  };
}

function normalizeResult(result) {
  if (!result) return null;
  const home = Number(result.home ?? result.homeGoals);
  const away = Number(result.away ?? result.awayGoals);
  const halfHome = Number(result.halfHome ?? result.htHome ?? result.halfTimeHome);
  const halfAway = Number(result.halfAway ?? result.htAway ?? result.halfTimeAway);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  return { home, away, halfHome: Number.isFinite(halfHome) ? halfHome : null, halfAway: Number.isFinite(halfAway) ? halfAway : null };
}

function makeFixtureId(date, homeTeam, awayTeam, index) {
  return `${date}-${safeName(homeTeam)}-vs-${safeName(awayTeam)}-${index + 1}`;
}

function safeName(value) {
  return String(value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function safeDate(value) {
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  if (!match) throw new Error(`无效日期：${value}`);
  return match[0];
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function ensureFixtureDir() {
  mkdirSync(fixtureDir, { recursive: true });
}
