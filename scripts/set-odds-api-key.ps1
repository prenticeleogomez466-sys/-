param(
  [Parameter(Mandatory = $true)]
  [string]$Key
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigureScript = Join-Path $ScriptDir "configure-football-data-sources.ps1"
& $ConfigureScript -OddsApiKey $Key
