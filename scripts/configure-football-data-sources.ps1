param(
  [string]$OddsApiKey,
  [string]$OddsApiIoKey,
  [string]$OddsJsonUrl,
  [string]$OddsCsvUrl,
  [string]$ApiFootballKey,
  [string]$FootballDataOrgToken,
  [string]$SportmonksApiToken,
  [string]$FootballDataCoUkEnabled,
  [string]$OddsApiRegions = "eu,uk,us",
  [string]$OddsApiSports = "soccer_epl,soccer_spain_la_liga,soccer_germany_bundesliga,soccer_italy_serie_a,soccer_france_ligue_one,soccer_uefa_champs_league,soccer_uefa_europa_league,soccer_portugal_primeira_liga,soccer_norway_eliteserien",
  [string]$OddsMaxAgeMinutes = "180",
  [switch]$RequireAuthorizedFixtures
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = if ([string]::IsNullOrWhiteSpace($env:FOOTBALL_DATA_DIR)) { "D:\football-model-data" } else { $env:FOOTBALL_DATA_DIR }
$EnvPath = Join-Path $DataDir "local.env"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$Existing = [ordered]@{}
if (Test-Path -LiteralPath $EnvPath) {
  Get-Content -LiteralPath $EnvPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$') { $Existing[$matches[1]] = $matches[2] }
  }
}

function Set-IfValue([string]$Key, [string]$Value) {
  if ($null -ne $Value -and $Value.Trim().Length -gt 0) {
    Assert-RealValue $Key $Value
    $Existing[$Key] = $Value.Trim()
  }
}

function Assert-RealValue([string]$Key, [string]$Value) {
  $Trimmed = $Value.Trim()
  $Placeholders = @(
    'example.com',
    'market-YYYY-MM-DD',
    'ODDS_API_KEY',
    'API_FOOTBALL_KEY',
    'APIKey',
    'your-',
    'YOUR_',
    'REPLACE_ME'
  )
  foreach ($Placeholder in $Placeholders) {
    if ($Trimmed -like "*$Placeholder*") {
      throw "$Key is still a placeholder. Replace it with a real authorized value."
    }
  }
  if ($Trimmed -match '\p{IsCJKUnifiedIdeographs}') {
    throw "$Key contains placeholder Chinese text. Replace it with the real authorized value."
  }
  if ($Key -like '*URL' -and $Trimmed -notmatch '^https://') {
    throw "$Key must be a public HTTPS authorized URL."
  }
}

Set-IfValue "ODDS_API_KEY" $OddsApiKey
Set-IfValue "ODDS_API_IO_KEY" $OddsApiIoKey
Set-IfValue "ODDS_JSON_URL" $OddsJsonUrl
Set-IfValue "ODDS_CSV_URL" $OddsCsvUrl
Set-IfValue "API_FOOTBALL_KEY" $ApiFootballKey
Set-IfValue "FOOTBALL_DATA_ORG_TOKEN" $FootballDataOrgToken
Set-IfValue "SPORTMONKS_API_TOKEN" $SportmonksApiToken
Set-IfValue "FOOTBALL_DATA_CO_UK_ENABLED" $FootballDataCoUkEnabled
Set-IfValue "ODDS_API_REGIONS" $OddsApiRegions
Set-IfValue "ODDS_API_SPORTS" $OddsApiSports
Set-IfValue "ODDS_MAX_AGE_MINUTES" $OddsMaxAgeMinutes

$Existing["ODDS_REQUIRE_COMPLETE"] = "1"
$Existing["FREE_ODDS_ONLY"] = "1"
$Existing["FREE_MODE_REQUIRE_HANDICAP"] = if ($Existing.Contains("FREE_MODE_REQUIRE_HANDICAP")) { $Existing["FREE_MODE_REQUIRE_HANDICAP"] } else { "0" }
$Existing["ODDS_REQUIRE_COMPLETE"] = if ($Existing["FREE_MODE_REQUIRE_HANDICAP"] -eq "1") { "1" } else { "0" }
$Existing["ODDS_REQUIRE_REALTIME"] = "1"
if ($RequireAuthorizedFixtures) { $Existing["DATA_SOURCE_REQUIRE_FIXTURES"] = "1" }
elseif (-not $Existing.Contains("DATA_SOURCE_REQUIRE_FIXTURES")) { $Existing["DATA_SOURCE_REQUIRE_FIXTURES"] = "0" }

$Order = @("FREE_ODDS_ONLY","FREE_MODE_REQUIRE_HANDICAP","ODDS_API_KEY","ODDS_API_IO_KEY","ODDS_JSON_URL","ODDS_CSV_URL","API_FOOTBALL_KEY","FOOTBALL_DATA_ORG_TOKEN","FOOTBALL_DATA_CO_UK_ENABLED","SPORTMONKS_API_TOKEN","ODDS_API_REGIONS","ODDS_API_SPORTS","ODDS_REQUIRE_COMPLETE","ODDS_REQUIRE_REALTIME","ODDS_MAX_AGE_MINUTES","DATA_SOURCE_REQUIRE_FIXTURES")
$Lines = New-Object System.Collections.Generic.List[string]
foreach ($Key in $Order) {
  if ($Existing.Contains($Key) -and $null -ne $Existing[$Key] -and "$($Existing[$Key])".Length -gt 0) { $Lines.Add("$Key=$($Existing[$Key])") }
}
foreach ($Key in $Existing.Keys) {
  if ($Order -notcontains $Key -and $null -ne $Existing[$Key] -and "$($Existing[$Key])".Length -gt 0) { $Lines.Add("$Key=$($Existing[$Key])") }
}

Set-Content -LiteralPath $EnvPath -Value $Lines -Encoding UTF8

function Mask([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "NOT_CONFIGURED" }
  if ($Value.Length -le 8) { return "********" }
  return $Value.Substring(0, 4) + "********" + $Value.Substring($Value.Length - 4)
}

$OddsJsonDisplay = if ($Existing.Contains("ODDS_JSON_URL")) { $Existing["ODDS_JSON_URL"] } else { "NOT_CONFIGURED" }
$OddsCsvDisplay = if ($Existing.Contains("ODDS_CSV_URL")) { $Existing["ODDS_CSV_URL"] } else { "NOT_CONFIGURED" }
$OddsKeyDisplay = if ($Existing.Contains("ODDS_API_KEY")) { Mask $Existing["ODDS_API_KEY"] } else { "NOT_CONFIGURED" }
$OddsApiIoDisplay = if ($Existing.Contains("ODDS_API_IO_KEY")) { Mask $Existing["ODDS_API_IO_KEY"] } else { "NOT_CONFIGURED" }
$ApiFootballDisplay = if ($Existing.Contains("API_FOOTBALL_KEY")) { Mask $Existing["API_FOOTBALL_KEY"] } else { "NOT_CONFIGURED" }
$FootballDataDisplay = if ($Existing.Contains("FOOTBALL_DATA_ORG_TOKEN")) { Mask $Existing["FOOTBALL_DATA_ORG_TOKEN"] } else { "NOT_CONFIGURED" }
$SportmonksDisplay = if ($Existing.Contains("SPORTMONKS_API_TOKEN")) { Mask $Existing["SPORTMONKS_API_TOKEN"] } else { "NOT_CONFIGURED" }

Write-Host "Saved authorized football data source config: $EnvPath"
Write-Host "ODDS_API_KEY=$OddsKeyDisplay"
Write-Host "ODDS_API_IO_KEY=$OddsApiIoDisplay"
Write-Host "ODDS_JSON_URL=$OddsJsonDisplay"
Write-Host "ODDS_CSV_URL=$OddsCsvDisplay"
Write-Host "API_FOOTBALL_KEY=$ApiFootballDisplay"
Write-Host "FOOTBALL_DATA_ORG_TOKEN=$FootballDataDisplay"
Write-Host "SPORTMONKS_API_TOKEN=$SportmonksDisplay"
