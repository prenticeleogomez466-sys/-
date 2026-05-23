param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "data\logs"
$EnvPath = Join-Path $Root "data\local.env"
$HealthUrl = "http://127.0.0.1:$Port/api/health"
$QueryUrl = "http://127.0.0.1:$Port/api/wechat/query"
$OutLog = Join-Path $LogDir "wechat-server.out.log"
$ErrLog = Join-Path $LogDir "wechat-server.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Read-LocalEnvValue {
  param([string]$Name)
  if (-not (Test-Path $EnvPath)) { return "" }
  $line = Get-Content -LiteralPath $EnvPath | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -replace "^$([regex]::Escape($Name))=", "").Trim()
}

function Test-JsonEndpoint {
  param([string]$Url)
  try {
    Invoke-RestMethod -Uri $Url -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-JsonEndpoint -Url $HealthUrl)) {
  Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
  $ready = $false
  foreach ($attempt in 1..12) {
    Start-Sleep -Milliseconds 750
    if (Test-JsonEndpoint -Url $HealthUrl) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    throw "WeChat local server failed to start. See $ErrLog"
  }
}

$token = Read-LocalEnvValue -Name "WECHAT_QUERY_TOKEN"
if (-not $token) {
  throw "Missing WECHAT_QUERY_TOKEN; cannot verify WeChat query endpoint."
}

$body = @{ text = "health"; date = $Date } | ConvertTo-Json -Compress
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$query = Invoke-RestMethod -Method Post -Uri $QueryUrl -Headers $headers -Body $body -TimeoutSec 8

npm.cmd run wechat:check -- --date=$Date | Out-Host

[pscustomobject]@{
  ok = $true
  date = $Date
  healthUrl = $HealthUrl
  queryUrl = $QueryUrl
  queryOk = [bool]$query.ok
  gateOk = [bool]$query.gateOk
  xlsxReady = [bool]$query.xlsxReady
  log = $OutLog
} | ConvertTo-Json -Compress
