Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Push-Location $repoRoot
try {
    & compose-agentsmd
} finally {
    Pop-Location
}

Write-Output 'Build OK.'
