param(
    [ValidateSet('ensure', 'attach', 'attach-hidden', 'ensure-live-updates', 'list', 'exists', 'kill')]
    [string]$Action = 'ensure',

    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$SessionName,

    [ValidateSet('codex', 'claude', 'gemini', 'shell')]
    [string]$SessionType,

    [string]$SessionLabel,

    [string]$Distro = 'Ubuntu',
    [ValidatePattern('^[A-Za-z0-9._-]*$')]
    [string]$SocketName = '',
    [string]$WorkingDirectory = '',
    [string]$StartupCommand,
    [int]$WindowWidth = 120,
    [int]$WindowHeight = 40,
    [switch]$Detach,
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$startupOnAttachScriptWindowsPath = Join-Path $PSScriptRoot 'wsl-startup-on-attach.sh'
if (-not (Test-Path -Path $startupOnAttachScriptWindowsPath)) {
    throw "Missing helper script: $startupOnAttachScriptWindowsPath"
}
$sessionLivePipeScriptWindowsPath = Join-Path $PSScriptRoot 'wsl-session-live-pipe.sh'
if (-not (Test-Path -Path $sessionLivePipeScriptWindowsPath)) {
    throw "Missing helper script: $sessionLivePipeScriptWindowsPath"
}

$sessionLiveRootWindowsPath = Join-Path $env:USERPROFILE 'agent-handoff\session-live'

function ConvertTo-QuotedArgumentString {
    param(
        [string[]]$ArgumentList = @()
    )

    $quoted = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if (-not $value.Length) {
            '""'
            continue
        }
        if ($value -notmatch '[\s"]') {
            $value
            continue
        }

        $escaped = $value -replace '(\\*)"', '$1$1\"'
        $escaped = $escaped -replace '(\\+)$', '$1$1'
        '"' + $escaped + '"'
    }

    return ($quoted -join ' ')
}

function Ensure-WindowsUtf8File {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $parentPath = [System.IO.Path]::GetDirectoryName($Path)
    if ($parentPath) {
        [void][System.IO.Directory]::CreateDirectory($parentPath)
    }
    if (-not [System.IO.File]::Exists($Path)) {
        [System.IO.File]::WriteAllText($Path, '', [System.Text.UTF8Encoding]::new($false))
    }
}

function Invoke-WslCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowNonZeroExit,
        [int]$Retries = 0,
        [int]$RetryDelayMilliseconds = 200
    )

    $attempt = 0
    do {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = 'wsl.exe'
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
        if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
            foreach ($argument in $Arguments) {
                [void]$startInfo.ArgumentList.Add([string]$argument)
            }
        } else {
            $startInfo.Arguments = ConvertTo-QuotedArgumentString -ArgumentList $Arguments
        }

        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $stdoutText = $process.StandardOutput.ReadToEnd()
        $stderrText = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        if ($AllowNonZeroExit -or $exitCode -eq 0) {
            return $exitCode
        }
        if ($attempt -ge $Retries) {
            $detail = if ($stderrText.Trim()) { $stderrText.Trim() } elseif ($stdoutText.Trim()) { $stdoutText.Trim() } else { '' }
            if ($detail) {
                throw "wsl.exe failed with exit code $exitCode. Args: $($Arguments -join ' ') $detail"
            }
            throw "wsl.exe failed with exit code $exitCode. Args: $($Arguments -join ' ')"
        }
        Start-Sleep -Milliseconds $RetryDelayMilliseconds
        $attempt += 1
    } while ($true)
}

function Convert-ToBashSingleQuotedLiteral {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $singleQuote = [string][char]39
    $escaped = $Value -replace "'", ($singleQuote + '"' + $singleQuote + '"' + $singleQuote)
    return ($singleQuote + $escaped + $singleQuote)
}

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath
    )

    if ($WindowsPath -match '^(?<drive>[A-Za-z]):(?<rest>\\.*)?$') {
        $driveLetter = $Matches['drive'].ToLowerInvariant()
        $rest = if ($Matches['rest']) { ($Matches['rest'] -replace '\\', '/') } else { '' }
        return "/mnt/$driveLetter$rest"
    }

    $normalizedPath = $WindowsPath -replace '\\', '/'
    $attempt = 0
    do {
        $result = & wsl.exe -d $Distro -- wslpath -a -u $normalizedPath
        if ($LASTEXITCODE -eq 0) {
            return (($result | Out-String).Trim())
        }
        if ($attempt -ge 2) {
            throw "Unable to convert Windows path to WSL path: $WindowsPath"
        }
        Start-Sleep -Milliseconds 200
        $attempt += 1
    } while ($true)
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

function Start-HiddenTmuxAttachClient {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro,
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [int]$TargetWindowWidth,
        [Parameter(Mandatory = $true)]
        [int]$TargetWindowHeight
    )

    [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @(
        'set-window-option',
        '-t', $TargetSessionName,
        'window-size',
        'manual'
    )))
    [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @(
        'resize-window',
        '-t', $TargetSessionName,
        '-x', [string]$TargetWindowWidth,
        '-y', [string]$TargetWindowHeight
    )))

    Start-Process -FilePath 'wsl.exe' -ArgumentList (Get-TmuxCommandArguments -TmuxArguments @(
        'attach-session',
        '-t', $TargetSessionName
    )) -WindowStyle Hidden | Out-Null
}

function Get-TmuxCommandArguments {
    param(
        [string[]]$TmuxArguments = @()
    )

    $arguments = @('-d', $Distro, '--', 'tmux')
    if ($SocketName) {
        $arguments += @('-L', $SocketName)
    }
    if ($TmuxArguments.Count -gt 0) {
        $arguments += $TmuxArguments
    }

    return $arguments
}

function Get-TmuxShellCommand {
    if ($SocketName) {
        return "tmux -L '$SocketName'"
    }

    return 'tmux'
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

function Set-TmuxServerOption {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$TmuxArguments
    )

    [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments $TmuxArguments) -Retries 5 -RetryDelayMilliseconds 300)
}

function Ensure-TmuxServerDefaults {
    try {
        Set-TmuxServerOption -TmuxArguments @('set-option', '-g', 'mouse', 'on')
    } catch {
        # Headless bootstrap should not fail solely because tmux convenience defaults are temporarily unavailable.
    }
    try {
        Set-TmuxServerOption -TmuxArguments @('set-option', '-g', 'history-limit', '200000')
    } catch {
        # Headless bootstrap should not fail solely because tmux convenience defaults are temporarily unavailable.
    }
}

function Test-TmuxSessionExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    $tmuxShellCommand = Get-TmuxShellCommand
    $quotedSessionName = Convert-ToBashSingleQuotedLiteral -Value $TargetSessionName
    $commandText = @'
if {0} has-session -t {1} >/dev/null 2>&1; then
    exit 0
fi
exit 1
'@ -f $tmuxShellCommand, $quotedSessionName

    $exitCode = Invoke-WslCommand -Arguments @(
        '-d', $Distro, '--',
        'bash', '-lc', $commandText
    ) -AllowNonZeroExit
    return ($exitCode -eq 0)
}

function Wait-ForTmuxSessionReady {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [int]$Retries = 10,
        [int]$RetryDelayMilliseconds = 200
    )

    for ($attempt = 0; $attempt -le $Retries; $attempt += 1) {
        if (Test-TmuxSessionExists -TargetSessionName $TargetSessionName) {
            return
        }
        if ($attempt -ge $Retries) {
            throw "tmux session '$TargetSessionName' did not become ready in distro '$Distro'."
        }
        Start-Sleep -Milliseconds $RetryDelayMilliseconds
    }
}

function Ensure-TmuxSessionLiveUpdates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    $transcriptPathWindows = Join-Path $sessionLiveRootWindowsPath ($TargetSessionName + '.log')
    $eventPathWindows = Join-Path $sessionLiveRootWindowsPath ($TargetSessionName + '.event')
    Ensure-WindowsUtf8File -Path $transcriptPathWindows
    Ensure-WindowsUtf8File -Path $eventPathWindows
    $tmuxShellCommand = Get-TmuxShellCommand
    $quotedSessionName = Convert-ToBashSingleQuotedLiteral -Value $TargetSessionName
    $transcriptPathWsl = Convert-WindowsPathToWslPath -WindowsPath $transcriptPathWindows
    $eventPathWsl = Convert-WindowsPathToWslPath -WindowsPath $eventPathWindows
    $quotedTranscriptPath = Convert-ToBashSingleQuotedLiteral -Value $transcriptPathWsl
    $quotedEventPath = Convert-ToBashSingleQuotedLiteral -Value $eventPathWsl
    $pipeHelperWslPath = Convert-WindowsPathToWslPath -WindowsPath $sessionLivePipeScriptWindowsPath
    $quotedPipeHelperPath = Convert-ToBashSingleQuotedLiteral -Value $pipeHelperWslPath
    $pipeCommand = "bash $quotedPipeHelperPath $quotedTranscriptPath $quotedEventPath"
    $clearPipeCommand = "$tmuxShellCommand pipe-pane -t $quotedSessionName >/dev/null 2>&1 || true"
    $openPipeCommand = @'
{0} pipe-pane -o -t {1} "{2}" >/dev/null 2>&1 || true
'@ -f $tmuxShellCommand, $quotedSessionName, $pipeCommand

    [void](Invoke-WslCommand -Arguments @(
        '-d', $Distro, '--',
        'bash', '-lc', $clearPipeCommand
    ) -AllowNonZeroExit -Retries 4 -RetryDelayMilliseconds 300)
    [void](Invoke-WslCommand -Arguments @(
        '-d', $Distro, '--',
        'bash', '-lc', $openPipeCommand
    ) -AllowNonZeroExit -Retries 4 -RetryDelayMilliseconds 300)
}

if ($Action -eq 'list') {
    $tmuxShellCommand = Get-TmuxShellCommand
    $listCommand = "if $tmuxShellCommand list-sessions -F '#{session_name}`t#{session_created}`t#{session_attached}`t#{session_windows}`t#{session_activity}' 2>/dev/null; then true; else true; fi"
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'wsl.exe'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    $listArguments = @('-d', $Distro, '--', 'bash', '-lc', $listCommand)
    if ($startInfo.PSObject.Properties.Name -contains 'ArgumentList') {
        foreach ($argument in $listArguments) {
            [void]$startInfo.ArgumentList.Add([string]$argument)
        }
    } else {
        $startInfo.Arguments = ConvertTo-QuotedArgumentString -ArgumentList $listArguments
    }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutText = $process.StandardOutput.ReadToEnd()
    $stderrText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Failed to list tmux sessions in distro '$Distro'."
    }
    $rawList = if ($stdoutText) { @($stdoutText -split "`r?`n") | Where-Object { $_ -ne '' } } else { @() }

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

    $sorted = @($items | Sort-Object -Property LastActivityUnix -Descending)
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
    $tmuxShellCommand = Get-TmuxShellCommand
    $killExitCode = Invoke-WslCommand -Arguments @(
        '-d', $Distro, '--',
        'bash', '-lc',
        "$tmuxShellCommand kill-session -t '$resolvedSessionName' >/dev/null 2>&1"
    ) -AllowNonZeroExit

    if ($killExitCode -eq 0) {
        Write-Output "Killed tmux session '$resolvedSessionName' in distro '$Distro'."
    } else {
        Write-Output "tmux session '$resolvedSessionName' was already absent in distro '$Distro'."
    }
    exit 0
}

$tmuxShellCommand = Get-TmuxShellCommand
$sessionExists = Test-TmuxSessionExists -TargetSessionName $resolvedSessionName

if ($Action -eq 'exists') {
    if ($sessionExists) {
        Write-Output 'true'
    } else {
        Write-Output 'false'
    }
    exit 0
}

if (-not $sessionExists -and $Action -eq 'attach') {
    throw "tmux session '$resolvedSessionName' does not exist in distro '$Distro'."
}

if (-not $sessionExists -and $Action -eq 'attach-hidden') {
    throw "tmux session '$resolvedSessionName' does not exist in distro '$Distro'."
}

if ($Action -eq 'ensure-live-updates') {
    if (-not $sessionExists) {
        throw "tmux session '$resolvedSessionName' does not exist in distro '$Distro'."
    }
    Ensure-TmuxServerDefaults
    Ensure-TmuxSessionLiveUpdates -TargetSessionName $resolvedSessionName
    Write-Output "Configured live updates for tmux session '$resolvedSessionName' in distro '$Distro'."
    exit 0
}

if ($Action -eq 'attach-hidden') {
    Ensure-TmuxServerDefaults
    Ensure-TmuxSessionLiveUpdates -TargetSessionName $resolvedSessionName
    Start-HiddenTmuxAttachClient -TargetDistro $Distro -TargetSessionName $resolvedSessionName -TargetWindowWidth $WindowWidth -TargetWindowHeight $WindowHeight
    Write-Output "Started hidden tmux attach client for '$resolvedSessionName' in distro '$Distro'."
    exit 0
}

if (-not $sessionExists) {
    $createArgs = Get-TmuxCommandArguments -TmuxArguments @(
        'new-session', '-d',
        '-s', $resolvedSessionName
    )

    if ($WorkingDirectory) {
        $createArgs += @('-c', $WorkingDirectory)
    }

    $createFailure = $null
    try {
        [void](Invoke-WslCommand -Arguments $createArgs -Retries 5 -RetryDelayMilliseconds 300)
    } catch {
        $createFailure = $_
    }
    try {
        Wait-ForTmuxSessionReady -TargetSessionName $resolvedSessionName -Retries 20 -RetryDelayMilliseconds 500
    } catch {
        if ($createFailure) {
            throw $createFailure
        }
        throw
    }
    Ensure-TmuxServerDefaults
    Ensure-TmuxSessionLiveUpdates -TargetSessionName $resolvedSessionName

    if ($StartupCommand -and -not $Detach) {
        Start-WslStartupOnAttach -TargetDistro $Distro -TargetSessionName $resolvedSessionName -TargetStartupCommand $StartupCommand
    } elseif ($StartupCommand -and $Detach) {
        [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @(
            'send-keys',
            '-t', $resolvedSessionName,
            '-l',
            $StartupCommand
        )))
        [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @(
            'send-keys',
            '-t', $resolvedSessionName,
            'Enter'
        )))
    }

    Write-Output "Created tmux session '$resolvedSessionName' in distro '$Distro'."
} else {
    Ensure-TmuxServerDefaults
    Ensure-TmuxSessionLiveUpdates -TargetSessionName $resolvedSessionName
    Write-Output "Reusing existing tmux session '$resolvedSessionName' in distro '$Distro'."
}

if ($Action -eq 'attach') {
    [void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @('attach-session', '-t', $resolvedSessionName)))
    exit 0
}

if ($Detach) {
    exit 0
}

[void](Invoke-WslCommand -Arguments (Get-TmuxCommandArguments -TmuxArguments @('attach-session', '-t', $resolvedSessionName)))
