Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

. (Join-Path $PSScriptRoot 'npm-bootstrap.ps1')
. (Join-Path $PSScriptRoot 'build-command.ps1')

Invoke-WithRepoMutationLock -RepoRoot $repoRoot -ActionDescription 'package build' -ScriptBlock {
    if (-not (Test-NpmDependencySurfaceReady -RepoRoot $repoRoot)) {
        Invoke-NpmDependencySurfaceRepair -RepoRoot $repoRoot -LogPrefix '[build-package]'
    }

    Invoke-WorkspaceAgentHubBuildCommand -RepoRoot $repoRoot
}
