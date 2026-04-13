Set-StrictMode -Version Latest

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$packageJsonPath = Join-Path $repoRoot 'package.json'
$tscPath = Join-Path $repoRoot 'node_modules\.bin\tsc.cmd'

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')

Push-Location $repoRoot
try {
    if ((Test-Path -Path $packageJsonPath) -and (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot))) {
        Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[typecheck]'
    }

    if (-not (Test-Path -Path $tscPath)) {
        throw "Missing TypeScript compiler shim: $tscPath"
    }

    & $tscPath '--noEmit'
    if ($LASTEXITCODE -ne 0) {
        throw 'TypeScript typecheck failed.'
    }
} finally {
    Pop-Location
}
