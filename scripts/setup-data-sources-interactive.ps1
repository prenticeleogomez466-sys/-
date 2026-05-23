param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ConfigureScript = Join-Path $Root "scripts\configure-football-data-sources.ps1"

function Read-SecretText([string]$Prompt) {
  $Secure = Read-Host $Prompt -AsSecureString
  $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
  }
}

Write-Host ""
Write-Host "足球大模型授权数据源配置"
Write-Host "注意：输入内容只会写入本机 data/local.env，不会显示到聊天。"
Write-Host ""

$OddsApiKey = Read-SecretText "请输入真实 ODDS_API_KEY"
$OddsApiIoKey = Read-SecretText "请输入真实 ODDS_API_IO_KEY（没有就直接回车）"
$OddsJsonUrl = Read-Host "请输入真实 ODDS_JSON_URL（HTTPS，让球胜平负 JSON；没有就留空）"
$OddsCsvUrl = Read-Host "请输入真实 ODDS_CSV_URL（HTTPS，让球胜平负 CSV；没有就留空）"
$ApiFootballKey = Read-SecretText "请输入真实 API_FOOTBALL_KEY（没有就直接回车）"
$FootballDataOrgToken = Read-SecretText "请输入真实 FOOTBALL_DATA_ORG_TOKEN（没有就直接回车）"
$SportmonksApiToken = Read-SecretText "请输入真实 SPORTMONKS_API_TOKEN（没有就直接回车）"

& $ConfigureScript `
  -OddsApiKey $OddsApiKey `
  -OddsApiIoKey $OddsApiIoKey `
  -OddsJsonUrl $OddsJsonUrl `
  -OddsCsvUrl $OddsCsvUrl `
  -ApiFootballKey $ApiFootballKey `
  -FootballDataOrgToken $FootballDataOrgToken `
  -SportmonksApiToken $SportmonksApiToken

Write-Host ""
Write-Host "配置已写入。下一步请回到 Codex，我会继续检查 credentials:check:live。"
Read-Host "按回车关闭窗口"
