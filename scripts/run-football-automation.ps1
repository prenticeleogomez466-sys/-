param(
  [ValidateSet("health", "daily", "recap", "weekly", "lineup-watch", "market-refresh", "all")]
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

# 桌面《神选复盘.xlsx》新鲜度校验:核对桌面表确实在今天被刷新过(用户硬要求"永久"放桌面)。
# 不是今天刷新 / 不存在 → 打 ALERT、计入 $Steps 摘要(ok=$false),供健康监控发现。
function Verify-DesktopRecap {
  $Candidates = @(
    (Join-Path $env:USERPROFILE "Desktop\神选复盘.xlsx"),
    "D:\Users\Administrator\Desktop\神选复盘.xlsx"
  )
  $Fresh = $false
  $Found = $null
  foreach ($p in $Candidates) {
    if (Test-Path $p) {
      $Found = $p
      $age = (Get-Date) - (Get-Item $p).LastWriteTime
      if ((Get-Item $p).LastWriteTime.Date -eq (Get-Date).Date) { $Fresh = $true; $Found = $p; break }
    }
  }
  if ($Fresh) {
    Write-Log "VERIFY: 桌面《神选复盘.xlsx》今日已刷新 => OK ($Found)"
  } else {
    $Msg = if ($Found) { "桌面《神选复盘.xlsx》存在但非今日刷新($Found),疑 recap:desktop 失败" } else { "桌面《神选复盘.xlsx》不存在,recap:desktop 未产出桌面副本" }
    Write-Log "ALERT: $Msg"
  }
  $Steps.Add([ordered]@{
    name = "verify desktop 神选复盘 freshness"
    command = "Test-Path + LastWriteTime"
    ok = $Fresh
    allowedFailure = $false
    exitCode = if ($Fresh) { 0 } else { 1 }
    startedAt = (Get-Date).ToString("o")
    finishedAt = (Get-Date).ToString("o")
    seconds = 0
  })
  return $Fresh
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
  # 深度实测体检(真发请求逐源判 实测/存疑 + 与上次对比告警),源挂了不阻塞主线。
  Invoke-Step "deep data source health probe" "npm run sources:health-probe" $true
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
  Invoke-Step "sync API-Football team form" "npm run sync:api-football -- --date $Date"
  # 世界杯特征保鲜(2026-06-06):Open-Meteo 只给 ~16 天预报,要覆盖整届(6/11–7/19)必须每天重拉,
  #   否则 venueLambdaMultiplier 一直用旧预报(开赛前会 stale)。AllowFailure:源挂了不阻塞主线。
  Invoke-Step "refresh World Cup weather forecast (16-day window)" "npm run sync:wc-weather" $true
  Invoke-Step "refresh World Cup schedule/match-dates" "npm run sync:wc-schedule" $true
  #   实时夺冠盘(Betfair outright)刷新 team-priors.title_odds → 超算 blend 原生吃最锐市场信号。
  Invoke-Step "refresh World Cup winner outright odds" "npm run sync:wc-winner" $true
  #   逐场临场 1X2(竞彩单场世界杯)→ match-odds.json → 超算单场市场融合(2026-06-07 体检补:此前无写入方、
  #   融合层永远休眠跑纯 Elo)。只写真实欧赔、14场胜负彩无欧赔自动跳过、无则不写(诚实不臆造)。AllowFailure。
  Invoke-Step "ingest World Cup per-match 1X2 odds" "npm run ingest:wc-odds" $true
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
  # 赛果回填(2026-05-31 用户"数据不全 全补上去"):授权源覆盖不全(国际赛/北欧/日职/欧冠等),
  # 用 ESPN 全联赛单日赛果按 canonical 主队锚定补进 store,大幅提升结算率。$true 失败不阻塞。
  Invoke-Step "backfill real results from ESPN" "npm run recap:backfill -- --date=$Date" $true
  # 半场比分回填(2026-06-04 用户"半全场睁眼"):ESPN 不带 HT、Sofascore 反爬,用 football-data.org
  # 免费档 score.halfTime 补世界杯+五大联赛+巴甲+欧冠的半场,让半全场玩法可结算/学习。无 token 优雅跳过。$true 失败不阻塞。
  Invoke-Step "backfill half-time scores from football-data.org" "npm run recap:backfill-ht -- --date=$Date" $true
  # 第二 HT 源(2026-06-05):API-Football free 档补 fd.org 漏的联赛(挪超/瑞超/日职/解放者/国际友谊赛)半场。
  # ⚠️ free 档仅近 ~3 天有数据,历史日期优雅跳过;100次/天足够(每日仅几次)。无 key 优雅跳过。$true 失败不阻塞。
  Invoke-Step "backfill half-time scores from API-Football (gap leagues)" "npm run recap:backfill-ht-af -- --date=$Date" $true
  # 用 --no-result-sync:store 已由上面两步填好,recap 只结算不再二次 sync(避免覆盖 ESPN 回填赛果)。
  Invoke-Step "compare predictions with actual results" "npm run recap:daily -- --date=$Date --no-result-sync"
  #   世界杯赛果复盘校准:开赛后逐场验证赛前预测(出线Brier/夺冠logloss/爆冷);开赛前空态冻结基线。AllowFailure。
  Invoke-Step "World Cup forecast recap calibration" "npm run wc:recap -- --json" $true
  Invoke-Step "run evolution backtest" "npm run backtest:evolution"
  # 神选复盘:把全部历史复盘汇成桌面单一总表(每日命中率+逐场明细),用户每天就看这一张。
  # 放在 recap:daily 之后 → 前一日赛果已回填,桌面表立即刷新到最新。
  Invoke-Step "build desktop 神选复盘 master table" "npm run recap:desktop" $true
  # 桌面表新鲜度校验(2026-06-05 加):此前 recap:desktop 静默失败 → 桌面《神选复盘.xlsx》无声消失、
  #   复盘任务仍报 0x0。现在显式核对桌面表是否今天刷新过;不是就打 ALERT 并计入摘要,不再悄悄漏。
  Verify-DesktopRecap
  Invoke-Step "recap automation health" "npm run recap:health -- --date=$Date"
}

function Run-Weekly {
  Invoke-Step "full test suite" "npm test"
  # 每联赛历史经验库刷新(含 ESPN 薄联赛纯赛果)+ 重出每联赛深度档,作为分析依据持续更新。
  Invoke-Step "rebuild per-league experience library" "npm run experience:build" $true
  Invoke-Step "rebuild league experience digest xlsx" "npm run experience:digest" $true
  # 近五年数据变化框架基础刷新(2026-05-31):全局经验 + 每联赛市场行为指纹(向全局收缩),不驱动主概率(回测裁决)。
  Invoke-Step "refresh 5yr data-change study" "npm run study:datachange" $true
  Invoke-Step "rebuild per-league data-change profile" "npm run profile:league-datachange" $true
  Invoke-Step "vetted source review" "npm run sources:vet -- --date=$Date"
  Invoke-Step "free source matrix review" "npm run freeodds:audit"
  # 生产校准档:football-data 全量 walk-forward 训练 isotonic(8900+场,leak-safe),只在 usable 时覆盖+自动备份。
  # 必须在 evolution backtest 之前——训练档先就位,evolution 的 hasUsableTrainedProfile 守卫即不会用薄账本版刷回(根治冷启动)。
  Invoke-Step "train production calibration profile (full-history isotonic)" "npm run calibration:train" $true
  Invoke-Step "run evolution backtest" "npm run backtest:evolution"
  # 自调优闭环:walk-forward 回测驱动信号权重 + 温度校准自动调参(--apply 内置只在变好时才写护栏)
  Invoke-Step "self-tuning optimize loop" "npm run optimize:loop" $true
}

# 首发轮询(2026-05-31 用户硬规则:出阵容后自动分析发一份)。
# 闸门检测到「新首发出现」才触发实时分析+推送;无新阵容静默退出,不刷屏。
# 由 FootballModel-LineupWatch 每 ~30 分钟跑一次,覆盖各场不同的开盘/出阵容时间。
function Run-LineupWatch {
  Push-Location $Root
  $GateOut = & cmd.exe /d /c "npm run lineup:watch-gate -- --date=$Date 2>&1"
  $GateCode = $LASTEXITCODE
  Pop-Location
  foreach ($Line in $GateOut) { Write-Log ([string]$Line) }
  Write-Log "lineup watch gate exit=$GateCode (0=有新阵容→触发, 3=无新阵容→跳过)"
  if ($GateCode -eq 0) {
    Write-Log "新首发到位 → 按当前实时情况+阵容跑分析并推送"
    Run-Daily
  } else {
    Write-Log "无新阵容,跳过本轮(不重复发)"
  }
}

# Near-kickoff odds refresh (CLV loop, 2026-05-31): refresh `current` toward closing late at
# night, independent of lineups. Free soft path (market:crawl:soft + china:sources, non-fatal).
# Scheduled FootballModel-MarketRefresh at 23:50 / 03:30; CaptureClosing freezes final at 06:30.
function Run-MarketRefresh {
  Invoke-Step "refresh free odds (current->near-closing)" "npm run market:crawl:soft -- --date=$Date" $true
  Invoke-Step "china official+500 fallback odds sync" "npm run china:sources -- --date=$Date --no-history" $true
}

Write-Log "Football automation started: Mode=$Mode Date=$Date AllowMissingOdds=$AllowMissingOdds"

switch ($Mode) {
  "health" { Run-Health }
  "daily" { Run-Health; Run-Daily }
  "recap" { Run-Recap }
  "weekly" { Run-Weekly }
  "lineup-watch" { Run-LineupWatch }
  "market-refresh" { Run-MarketRefresh }
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

# 无 BOM 写出:PS5.1 的 Set-Content -Encoding UTF8 会加 UTF-8 BOM(efbbbf),
#   导致严格 JSON 消费者(python json.load / Node JSON.parse(utf8))解析崩、
#   automation-*-latest.json 摘要读不出(health 的 latestRun 静默丢失)。改用 WriteAllText + UTF8Encoding($false)。
$SummaryJson = $Summary | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($SummaryPath, $SummaryJson, (New-Object System.Text.UTF8Encoding $false))
Write-Log "Summary written (no BOM): $SummaryPath"

if ($Failed.Count -gt 0) {
  exit 1
}
