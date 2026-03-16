param(
    [int]$Port = 3360,
    [string]$StatePath = '',
    [string]$AuthToken = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
if (-not (Test-Path -Path $ensureScriptPath)) {
    throw "Missing script: $ensureScriptPath"
}

& $ensureScriptPath -OpenBrowser -Port $Port -StatePath $StatePath -AuthToken $AuthToken
if ($LASTEXITCODE -ne 0) {
    throw 'Workspace Agent Hub could not be opened.'
}
