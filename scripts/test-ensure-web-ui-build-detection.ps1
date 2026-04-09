Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ensureScriptPath = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
$scriptText = Get-Content -Path $ensureScriptPath -Raw -Encoding utf8

if ($scriptText -notmatch 'foreach \(\$relativeDir in @\(''src'', ''public''\)\)') {
    throw 'Expected ensure-web-ui-running.ps1 to rebuild from recursive src/public inputs.'
}

if ($scriptText -notmatch 'Get-ChildItem -LiteralPath \$sourceRoot -Recurse -File') {
    throw 'Expected ensure-web-ui-running.ps1 to scan source trees recursively when deciding whether to rebuild.'
}

Write-Output 'PASS'
