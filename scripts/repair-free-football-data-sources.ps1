$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvPath = Join-Path $Root "data\local.env"

Push-Location $Root
try {
  @'
import { readLocalEnv, writeLocalEnv } from "./src/source-credentials.js";
const current = readLocalEnv();
const enabled = writeLocalEnv({
  ...current,
  CHINA_OFFICIAL_WEB_ENABLED: "1",
  SINA_SFC_ODDS_ENABLED: "1",
  FOOTBALL_DATA_CO_UK_ENABLED: "1",
  GDELT_NEWS_ENABLED: current.GDELT_NEWS_ENABLED ?? "1",
  OPEN_METEO_ENABLED: current.OPEN_METEO_ENABLED ?? "1",
  OPENLIGADB_ENABLED: current.OPENLIGADB_ENABLED ?? "0",
  SCOREBAT_ENABLED: current.SCOREBAT_ENABLED ?? "0",
  STATSBOMB_OPEN_DATA_ENABLED: current.STATSBOMB_OPEN_DATA_ENABLED ?? "0",
  OPENFOOTBALL_DATA_ENABLED: current.OPENFOOTBALL_DATA_ENABLED ?? "0",
  NOWSCORE_ODDS_ENABLED: current.NOWSCORE_ODDS_ENABLED ?? "1",
  CUBEGOAL_ODDS_ENABLED: current.CUBEGOAL_ODDS_ENABLED ?? "1",
  FREE_ODDS_ONLY: "1",
  ODDS_REQUIRE_REALTIME: "1"
}, { preserve: false });
console.log(JSON.stringify({ ok: true, path: enabled.path }, null, 2));
'@ | node --input-type=module
  npm run credentials:check
  npm run freeodds:audit
  npm run sources:audit
}
finally {
  Pop-Location
}

Write-Host "Free public football data sources repaired and audited: $EnvPath"
