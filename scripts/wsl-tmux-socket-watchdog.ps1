param(
    [Parameter(Mandatory = $true)]
    [int]$ParentPid,
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,
    [int]$PollIntervalMs = 250
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$distro = if (
    $env:WORKSPACE_AGENT_HUB_WSL_DISTRO -and
    $env:WORKSPACE_AGENT_HUB_WSL_DISTRO.Trim()
) {
    $env:WORKSPACE_AGENT_HUB_WSL_DISTRO.Trim()
} else {
    'Ubuntu'
}

while ($true) {
    $parentProcess = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -eq $parentProcess) {
        break
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}

if (-not (Test-Path -LiteralPath $ManifestPath)) {
    exit 0
}

try {
    $rawManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8
    if (-not $rawManifest.Trim()) {
        exit 0
    }

    $socketNames = @($rawManifest | ConvertFrom-Json)
} catch {
    exit 0
}

$resolvedSockets = @(
    $socketNames |
        Where-Object { $_ -and ([string]$_).Trim() } |
        ForEach-Object { ([string]$_).Trim() } |
        Select-Object -Unique
)

foreach ($socketName in $resolvedSockets) {
    try {
        [void](& wsl.exe -d $distro -- tmux -L $socketName kill-server 2>$null)
    } catch {
    }
}
