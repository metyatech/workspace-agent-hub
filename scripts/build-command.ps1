Set-StrictMode -Version Latest

function Invoke-WorkspaceAgentHubBuildCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    Push-Location $RepoRoot
    try {
        $testBuildCommandPath = ''
        if (
            $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH -and
            $env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH.Trim()
        ) {
            $testBuildCommandPath = [IO.Path]::GetFullPath($env:WORKSPACE_AGENT_HUB_TEST_BUILD_COMMAND_PATH.Trim())
        }

        if ($testBuildCommandPath) {
            & $testBuildCommandPath 2>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) {
                    [Console]::Error.WriteLine($_.ToString())
                } else {
                    [Console]::Error.WriteLine([string]$_)
                }
            }
            if ($LASTEXITCODE -ne 0) {
                throw 'test build command failed.'
            }
            return
        }

        & npm exec tsup 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                [Console]::Error.WriteLine($_.ToString())
            } else {
                [Console]::Error.WriteLine([string]$_)
            }
        }
        if ($LASTEXITCODE -ne 0) {
            throw 'npm exec tsup failed.'
        }
    } finally {
        Pop-Location
    }
}
