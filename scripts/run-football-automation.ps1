param(
  [ValidateSet("health", "daily", "recap", "weekly", "all")]
  [string]$Mode = "all",
  [string]$Date,
  [switch]$AllowMissingOdds
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = if ([string]::IsNullOrWhiteSpace($env:FOOTBALL_DATA_DIR)) { "D:\football-model-data" } else { $env:FOOTBALL_DATA_DIR }
$ExportDir = if ([string]::IsNullOrWhiteSpace($env:FOOTBALL_EXPORT_DIR)) { "D:\football-model-exports" } else { $env:FOOTBALL_EXPORT_DIR }
$LogDir = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir, $ExportDir | Out-Null

if ([string]::IsNullOrWhiteSpace($env:OBSIDIAN_VAULT_DIR)) {
  $DefaultObsidianVault = "D:\足球数据分析库\111"
  if (Test-Path (Join-Path $DefaultObsidianVault ".obsidian")) {
    $env:OBSIDIAN_VAULT_DIR = $DefaultObsidianVault
  }
}

if ([string]::IsNullOrWhiteSpace($Date)) {
  if ($Mode -eq "recap") {
    $Date = (Get-Date).AddDays(-1).ToString("yyyy-MM-dd")
  } else {
    $Date = Get-Date -Format "yyyy-MM-dd"
  }
}

$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $LogDir "football-$Mode-$Date-$RunId.log"
$SummaryPath = Join-Path $ExportDir "automation-$Mode-latest.json"
$Steps = New-Object System.Collections.Generic.List[object]

function Write-Log([string]$Text) {
  $Line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Text
  $Line | Tee-Object -FilePath $LogPath -Append
}

function Invoke-Step([string]$Name, [string]$Command, [bool]$AllowFailure = $false) {
  Write-Log "START: $Name"
  Write-Log "CMD: $Command"
  $Started = Get-Date
  Push-Location $Root
  try {
    # Use cmd.exe instead of nested powershell:
    # avoids child-PS SetConsoleWindowTitle host corruption (seen 2026-05-28),
    # and avoids PS 5.1 NativeCommandError wrapping that flags OK exits as failure.
    $Output = & cmd.exe /d /c "$Command 2>&1"
    $ExitCode = $LASTEXITCODE
    if ($null -eq $ExitCode) { $ExitCode = 0 }
    foreach ($Line in $Output) { Write-Log ([string]$Line) }
  } catch {
    $ExitCode = 1
    Write-Log $_.Exception.Message
  } finally {
    Pop-Location
  }
  $Finished = Get-Date
  $Ok = $ExitCode -eq 0 -or $AllowFailure
  $Steps.Add([ordered]@{
    name = $Name
    command = $Command
    ok = $Ok
    allowedFailure = $AllowFailure -and $ExitCode -ne 0
    exitCode = $ExitCode
    startedAt = $Started.ToString("o")
    finishedAt = $Finished.ToString("o")
    seconds = [math]::Round(($Finished - $Started).TotalSeconds, 2)
  })
  $Status = if ($ExitCode -eq 0) { "OK" } elseif ($AllowFailure) { "WARN" } else { "FAILED" }
  Write-Log "END: $Name => $Status"
  return $Ok
}

function Run-Health {
  if ($AllowMissingOdds) {
    Invoke-Step "realtime football crawler gate" "npm run crawler:realtime -- --date=$Date --allow-missing-odds --no-external-odds --no-history"
  } else {
    Invoke-Step "strict realtime football crawler gate" "npm run crawler:realtime:strict -- --date=$Date"
  }
  Invoke-Step "china official web source analysis" "npm run china:sources -- --date=$Date --no-history"
  Invoke-Step "vetted source review" "npm run sources:vet -- --date=$Date"
  Invoke-Step "free odds source audit" "npm run freeodds:audit"
  Invoke-Step "data source audit" "npm run sources:audit"
  Invoke-Step "credential check" "npm run credentials:check" $AllowMissingOdds.IsPresent
  Invoke-Step "wechat channel check" "npm run wechat:check"
  Invoke-Step "market coverage status" "npm run market:status -- --date=$Date"
  Invoke-Step "recommendation audit" "npm run recommend:audit -- --date $Date"
  Invoke-Step "model structure audit" "npm run model:audit -- --date=$Date"
  Invoke-Step "recap automation health" "npm run recap:health -- --date=$Date" $AllowMissingOdds.IsPresent
}

function Run-Daily {
  Invoke-Step "sync china official jingcai and 14 fixtures" "npm run china:sources:sync -- --date=$Date"
  Invoke-Step "sync free fixtures and results" "npm run fixtures:sync:soft -- --date=$Date"
  Invoke-Step "crawl free odds" "npm run market:crawl:soft -- --date=$Date"
  if (-not $AllowMissingOdds) {
    Invoke-Step "refresh strict realtime gate before generation" "npm run crawler:realtime:strict -- --date=$Date"
  }
  if ($AllowMissingOdds) {
    Invoke-Step "market status without strict odds gate" "npm run market:status -- --date=$Date"
  } else {
    Invoke-Step "verify odds gate" "npm run market:verify -- --date=$Date"
  }
  Invoke-Step "sync advanced free data layers" "npm run advanced:sync -- --date=$Date"
  Invoke-Step "strict data completeness check" "npm run standard:check -- --date=$Date"
  if ($AllowMissingOdds) {
    Invoke-Step "build offline daily xlsx" "npm run daily:no-web -- --date $Date"
  } else {
    # 官方优先 + 500 兜底:官方源间歇反爬(竞彩 567 / 14场 TLS 拒)时不再空跑,
    # 自动降级 500 兜底竞彩;官方14场成功但竞彩被封时补抓竞彩。见 scripts/daily-with-fallback.mjs。
    Invoke-Step "build daily xlsx (official-first + 500 fallback) and wechat outbox" "npm run daily:fallback -- --date $Date"
  }
}

function Run-Recap {
  Invoke-Step "sync previous-day results" "npm run fixtures:sync:soft -- --date=$Date"
  Invoke-Step "compare predictions with actual results" "npm run recap:daily -- --date=$Date"
  Invoke-Step "run evolution backtest" "npm run backtest:evolution"
  Invoke-Step "recap automation health" "npm run recap:health -- --date=$Date"
}

function Run-Weekly {
  Invoke-Step "full test suite" "npm test"
  Invoke-Step "vetted source review" "npm run sources:vet -- --date=$Date"
  Invoke-Step "free source matrix review" "npm run freeodds:audit"
  Invoke-Step "run evolution backtest" "npm run backtest:evolution"
  # 自调优闭环:walk-forward 回测驱动信号权重 + 温度校准自动调参(--apply 内置只在变好时才写护栏)
  Invoke-Step "self-tuning optimize loop" "npm run optimize:loop" $true
}

Write-Log "Football automation started: Mode=$Mode Date=$Date AllowMissingOdds=$AllowMissingOdds"

switch ($Mode) {
  "health" { Run-Health }
  "daily" { Run-Health; Run-Daily }
  "recap" { Run-Recap }
  "weekly" { Run-Weekly }
  "all" { Run-Health; Run-Daily; Run-Recap; Run-Weekly }
}

$Failed = @($Steps | Where-Object { -not $_.ok })
$Summary = [ordered]@{
  mode = $Mode
  date = $Date
  ok = $Failed.Count -eq 0
  failed = $Failed.Count
  total = $Steps.Count
  logPath = $LogPath
  generatedAt = (Get-Date).ToString("o")
  steps = $Steps
}

$Summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $SummaryPath -Encoding UTF8
Write-Log "Summary written: $SummaryPath"

if ($Failed.Count -gt 0) {
  exit 1
}
