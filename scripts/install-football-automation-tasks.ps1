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
# 各场开盘/出阵容时间不同,故每 30 分钟轮询一次(09:00 起,持续 23 小时覆盖全天含深夜赛),
# 闸门只在「新阵容出现」时触发分析+推送 → 不刷屏。
$LineupTrigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours(9)) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Hours 23)

New-FootballTask "$ProjectName-DailyEvolution" "daily" $DailyTrigger
New-FootballTask "$ProjectName-HealthMonitor" "health" $HealthTrigger
New-FootballTask "$ProjectName-RecapBacktest" "recap" $RecapTrigger
New-FootballTask "$ProjectName-WeeklyEvolution" "weekly" $WeeklyTrigger
New-FootballTask "$ProjectName-LineupWatch" "lineup-watch" $LineupTrigger

Get-ScheduledTask -TaskName "$ProjectName-*" | Select-Object TaskName, State, TaskPath
