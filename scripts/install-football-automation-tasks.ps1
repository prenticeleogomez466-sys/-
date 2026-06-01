param(
  [string]$DailyTime = "03:00",
  [string]$HealthTime = "03:00",
  [string]$RecapTime = "11:00",
  [string]$WeeklyTime = "03:00",
  [switch]$AllowMissingOdds
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $Root "scripts\run-football-automation.ps1"
$ProjectName = "FootballModel"

function New-FootballTask(
  [string]$TaskName,
  [string]$Mode,
  [object[]]$Trigger
) {
  $AllowFlag = if ($AllowMissingOdds) { " -AllowMissingOdds" } else { "" }
  $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -Mode $Mode$AllowFlag"
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments -WorkingDirectory $Root
  $Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3)
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "足球大模型自动化：$Mode" `
    -Force | Out-Null
}

$DailyTrigger = New-ScheduledTaskTrigger -Daily -At $DailyTime
$HealthHours = @($HealthTime)
$HealthTrigger = @()
foreach ($Time in $HealthHours) {
  $HealthTrigger += New-ScheduledTaskTrigger -Daily -At $Time
}
$RecapTrigger = New-ScheduledTaskTrigger -Daily -At $RecapTime
$WeeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $WeeklyTime

# 首发轮询(2026-05-31 用户硬规则:出阵容后自动分析发一份)。
# 各场开盘/出阵容时间不同,故每 30 分钟轮询一次(每日 09:00 起,持续 23 小时覆盖全天含深夜赛),
# 闸门只在「新阵容出现」时触发分析+推送 → 不刷屏。
# 2026-06-01 修真 bug:原用 -Once 锚定安装当天 09:00,23 小时窗口一过即永久停摆(不跨天重新武装),
# 实测 LineupWatch 装后约 23h 即 NextRunTime 变空、违反硬规则。改 -Daily 让每天自动重新武装。
$LineupTrigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$LineupTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At 9:00AM `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Hours 23)).Repetition

New-FootballTask "$ProjectName-DailyEvolution" "daily" $DailyTrigger
New-FootballTask "$ProjectName-HealthMonitor" "health" $HealthTrigger
New-FootballTask "$ProjectName-RecapBacktest" "recap" $RecapTrigger
New-FootballTask "$ProjectName-WeeklyEvolution" "weekly" $WeeklyTrigger
New-FootballTask "$ProjectName-LineupWatch" "lineup-watch" $LineupTrigger

Get-ScheduledTask -TaskName "$ProjectName-*" | Select-Object TaskName, State, TaskPath
