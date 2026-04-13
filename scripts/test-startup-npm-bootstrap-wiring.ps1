Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptAssertions = @(
    @{
        Path = Join-Path $PSScriptRoot 'ensure-web-ui-running.ps1'
        RequiredPatterns = @(
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'npm-bootstrap.ps1')"),
            'Invoke-WithRepoMutationLock -RepoRoot \$repoRoot',
            'Invoke-NpmDependencySurfaceRepair -RepoRoot \$repoRoot'
        )
    },
    @{
        Path = Join-Path $PSScriptRoot 'start-web-ui.ps1'
        RequiredPatterns = @(
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'npm-bootstrap.ps1')"),
            'Invoke-WithRepoMutationLock -RepoRoot \$repoRoot',
            'Invoke-NpmDependencySurfaceRepair -RepoRoot \$repoRoot'
        )
    },
    @{
        Path = Join-Path $PSScriptRoot 'start-web-ui-front-door.ps1'
        RequiredPatterns = @(
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'npm-bootstrap.ps1')"),
            'Invoke-WithRepoMutationLock -RepoRoot \$repoRoot',
            'Invoke-NpmDependencySurfaceRepair -RepoRoot \$repoRoot'
        )
    },
    @{
        Path = Join-Path $PSScriptRoot 'build-package.ps1'
        RequiredPatterns = @(
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'npm-bootstrap.ps1')"),
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'build-command.ps1')"),
            'Invoke-WithRepoMutationLock -RepoRoot \$repoRoot'
        )
    },
    @{
        Path = Join-Path $PSScriptRoot 'typecheck.ps1'
        RequiredPatterns = @(
            [regex]::Escape(". (Join-Path `$PSScriptRoot 'npm-bootstrap.ps1')"),
            'Invoke-NpmDependencySurfaceRepair -RepoRoot \$repoRoot',
            [regex]::Escape("& `$tscPath '--noEmit'")
        )
    }
)

foreach ($assertion in $scriptAssertions) {
    $scriptText = Get-Content -Path $assertion.Path -Raw -Encoding utf8
    foreach ($pattern in $assertion.RequiredPatterns) {
        if ($scriptText -notmatch $pattern) {
            throw "Expected $($assertion.Path) to contain pattern: $pattern"
        }
    }
}

Write-Output 'PASS'
