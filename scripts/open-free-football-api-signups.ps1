$ErrorActionPreference = "Stop"

$Urls = @(
  "https://odds-api.io/pricing/free",
  "https://dashboard.api-football.com/register",
  "https://the-odds-api.com/",
  "https://www.football-data.org/client/register",
  "https://www.football-data.co.uk/",
  "http://clubelo.com/",
  "https://open-meteo.com/",
  "https://www.gdeltproject.org/",
  "https://www.openligadb.de/",
  "https://github.com/statsbomb/open-data",
  "https://github.com/openfootball/football.json",
  "https://www.scorebat.com/video-api/"
)

foreach ($Url in $Urls) {
  Start-Process $Url
}

Write-Host "Opened official free football API registration pages."
Write-Host "After registering, save keys with:"
Write-Host 'npm run sources:configure -- -OddsApiIoKey "KEY" -ApiFootballKey "KEY" -OddsApiKey "KEY" -FootballDataOrgToken "KEY"'
