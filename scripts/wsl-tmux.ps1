param(
    [ValidateSet('ensure', 'attach', 'list', 'kill')]
    [string]$Action = 'ensure',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$SessionName,

    [ValidateSet('codex', 'claude', 'gemini', 'shell')]
    [string]$SessionType,

    [string]$SessionLabel,

    [string]$Distro = 'Ubuntu',
    [string]$WorkingDirectory = '',
    [string]$StartupCommand,
    [switch]$Detach,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$startupOnAttachScriptWindowsPath = Join-Path $PSScriptRoot 'wsl-startup-on-attach.sh'
if (-not (Test-Path -Path $startupOnAttachScriptWindowsPath)) {
    throw "Missing helper script: $startupOnAttachScriptWindowsPath"
}

function Invoke-WslCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowNonZeroExit
    )

    & wsl.exe @Arguments
    $exitCode = $LASTEXITCODE
    if (-not $AllowNonZeroExit -and $exitCode -ne 0) {
        throw "wsl.exe failed with exit code $exitCode. Args: $($Arguments -join ' ')"
    }

    return $exitCode
}

function Start-WslStartupOnAttach {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro,
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetStartupCommand
    )

    $helperRest = ($startupOnAttachScriptWindowsPath.Substring(2)) -replace '\\', '/'
    $helperPath = "/mnt/$($startupOnAttachScriptWindowsPath.Substring(0, 1).ToLowerInvariant())$helperRest"

    $argumentList = @(
        '-d', $TargetDistro, '--',
        'env',
        "TMUX_SESSION=$TargetSessionName",
        "TMUX_STARTUP=$TargetStartupCommand",
        'bash',
        $helperPath
    )

    Start-Process -FilePath 'wsl.exe' -ArgumentList $argumentList -WindowStyle Hidden | Out-Null
}

function ConvertTo-SafeSessionLabel {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $trimmed = $Value.Trim().ToLowerInvariant()
    if (-not $trimmed) {
        throw 'SessionLabel must not be empty.'
    }

    $safe = $trimmed -replace '[^a-z0-9._-]+', '-'
    $safe = $safe.Trim('-')
    if (-not $safe) {
        throw "SessionLabel '$Value' is not valid after normalization."
    }

    return $safe
}

function Resolve-SessionName {
    if ($SessionName) {
        return $SessionName
    }

    if (-not $SessionType) {
        throw 'Provide -SessionName, or both -SessionType and -SessionLabel.'
    }
    if (-not $SessionLabel) {
        throw 'Provide -SessionLabel when using -SessionType.'
    }

    $safeLabel = ConvertTo-SafeSessionLabel -Value $SessionLabel
    return "$SessionType-$safeLabel"
}

function Split-TypedSessionName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $match = [regex]::Match($Name, '^(codex|claude|gemini|shell)-(.+)$')
    if (-not $match.Success) {
        return @{
            Type = 'unknown'
            DisplayName = $Name
        }
    }

    return @{
        Type = $match.Groups[1].Value
        DisplayName = $match.Groups[2].Value
    }
}

[void](Invoke-WslCommand -Arguments @('-d', $Distro, '--', 'tmux', '-V'))

function Set-TmuxServerOption {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$TmuxArguments
    )

    [void](Invoke-WslCommand -Arguments (@('-d', $Distro, '--', 'tmux') + $TmuxArguments))
}

Set-TmuxServerOption -TmuxArguments @('set-option', '-g', 'mouse', 'on')
Set-TmuxServerOption -TmuxArguments @('set-option', '-g', 'history-limit', '200000')

if ($Action -eq 'list') {
    $rawList = & wsl.exe -d $Distro -- bash -lc "if tmux list-sessions -F '#{session_name}`t#{session_created}`t#{session_attached}`t#{session_windows}`t#{session_activity}' 2>/dev/null; then true; else true; fi"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to list tmux sessions in distro '$Distro'."
    }

    $items = @()
    foreach ($line in @($rawList)) {
        $text = [string]$line
        if (-not $text.Trim()) {
            continue
        }

        $parts = $text -split "`t", 5
        if ($parts.Count -lt 5) {
            continue
        }

        $nameParts = Split-TypedSessionName -Name $parts[0]

        $createdUnix = [long]$parts[1]
        $activityUnix = [long]$parts[4]
        $created = [DateTimeOffset]::FromUnixTimeSeconds($createdUnix).LocalDateTime
        $activity = [DateTimeOffset]::FromUnixTimeSeconds($activityUnix).LocalDateTime

        $items += [pscustomobject]@{
            Name = $parts[0]
            Type = $nameParts.Type
            DisplayName = $nameParts.DisplayName
            Distro = $Distro
            CreatedUnix = $createdUnix
            CreatedLocal = $created.ToString('yyyy-MM-dd HH:mm:ss')
            AttachedClients = [int]$parts[2]
            WindowCount = [int]$parts[3]
            LastActivityUnix = $activityUnix
            LastActivityLocal = $activity.ToString('yyyy-MM-dd HH:mm:ss')
        }
    }

    $sorted = $items | Sort-Object -Property LastActivityUnix -Descending
    if ($Json) {
        if ($sorted.Count -eq 0) {
            '[]'
        } else {
            $sorted | ConvertTo-Json -Depth 4
        }
    } else {
        $sorted
    }
    exit 0
}

$resolvedSessionName = Resolve-SessionName

if ($Action -eq 'kill') {
    $killExitCode = Invoke-WslCommand -Arguments @(
        '-d', $Distro, '--',
        'bash', '-lc',
        "tmux kill-session -t '$resolvedSessionName' >/dev/null 2>&1"
    ) -AllowNonZeroExit

    if ($killExitCode -eq 0) {
        Write-Output "Killed tmux session '$resolvedSessionName' in distro '$Distro'."
    } else {
        Write-Output "tmux session '$resolvedSessionName' was already absent in distro '$Distro'."
    }
    exit 0
}

$sessionCheckOutput = & wsl.exe -d $Distro -- bash -lc "if tmux has-session -t '$resolvedSessionName' >/dev/null 2>&1; then echo exists; else echo missing; fi"
if ($LASTEXITCODE -ne 0) {
    throw "Failed to check tmux session status for '$resolvedSessionName' in distro '$Distro'."
}

$sessionCheckState = ($sessionCheckOutput | Select-Object -Last 1).ToString().Trim()
$sessionExists = ($sessionCheckState -eq 'exists')

if (-not $sessionExists -and $Action -eq 'attach') {
    throw "tmux session '$resolvedSessionName' does not exist in distro '$Distro'."
}

if (-not $sessionExists) {
    $createArgs = @(
        '-d', $Distro, '--',
        'tmux', 'new-session', '-d',
        '-s', $resolvedSessionName
    )

    if ($WorkingDirectory) {
        $createArgs += @('-c', $WorkingDirectory)
    }

    [void](Invoke-WslCommand -Arguments $createArgs)

    if ($StartupCommand -and -not $Detach) {
        Start-WslStartupOnAttach -TargetDistro $Distro -TargetSessionName $resolvedSessionName -TargetStartupCommand $StartupCommand
    } elseif ($StartupCommand -and $Detach) {
        [void](Invoke-WslCommand -Arguments @(
            '-d', $Distro, '--',
            'tmux', 'send-keys',
            '-t', $resolvedSessionName,
            $StartupCommand,
            'C-m'
        ))
    }

    Write-Output "Created tmux session '$resolvedSessionName' in distro '$Distro'."
} else {
    Write-Output "Reusing existing tmux session '$resolvedSessionName' in distro '$Distro'."
}

if ($Action -eq 'attach') {
    [void](Invoke-WslCommand -Arguments @('-d', $Distro, '--', 'tmux', 'attach-session', '-t', $resolvedSessionName))
    exit 0
}

if ($Detach) {
    exit 0
}

[void](Invoke-WslCommand -Arguments @('-d', $Distro, '--', 'tmux', 'attach-session', '-t', $resolvedSessionName))
