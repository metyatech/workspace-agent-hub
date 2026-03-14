Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

git -C $repoRoot config core.hooksPath .githooks
Write-Output 'Git hooks configured.'
