Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$rulesetPath = Join-Path $repoRoot 'agent-ruleset.json'

if (-not (Test-Path -Path $rulesetPath)) {
    Write-Error "Missing ruleset: $rulesetPath"
    exit 1
}

try {
    Get-Content -Path $rulesetPath -Raw | ConvertFrom-Json | Out-Null
} catch {
    Write-Error "Invalid JSON in $rulesetPath"
    exit 1
}

Write-Output 'Lint OK.'
