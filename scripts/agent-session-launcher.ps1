param(
    [ValidateSet('gui', 'codex', 'claude', 'gemini', 'shell', 'new', 'start', 'resume', 'existing', 'list', 'mobile', 'rename', 'archive', 'unarchive', 'close', 'delete')]
    [string]$Mode = 'gui',
    [ValidateSet('codex', 'claude', 'gemini', 'shell')]
    [string]$Type,
    [string]$Name = '',
    [string]$Title = '',
    [string]$SessionName = '',
    [string]$Distro = 'Ubuntu',
    [string]$WorkingDirectory = '',
    [switch]$NoStartup,
    [switch]$Detach,
    [switch]$IncludeArchived,
    [switch]$Json,
    [switch]$SmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tmuxScriptPath = Join-Path $PSScriptRoot 'wsl-tmux.ps1'
$codexAuthSyncScriptPath = Join-Path $PSScriptRoot 'sync-codex-auth.ps1'
if (-not (Test-Path -Path $tmuxScriptPath)) {
    throw "Missing script: $tmuxScriptPath"
}
if (-not (Test-Path -Path $codexAuthSyncScriptPath)) {
    throw "Missing script: $codexAuthSyncScriptPath"
}

$repoRootPath = Resolve-Path (Join-Path $PSScriptRoot '..')
$sessionCatalogPath = Join-Path $env:USERPROFILE 'agent-handoff\session-catalog.json'
$workspaceRootPath = Split-Path -Parent $repoRootPath

$profiles = @{
    codex = @{
        Type = 'codex'
        StartupCommand = '$HOME/.local/bin/codex'
        HealthCheckCommand = '$HOME/.local/bin/codex --version'
        Label = 'Codex'
    }
    claude = @{
        Type = 'claude'
        StartupCommand = '$HOME/.local/bin/claude'
        HealthCheckCommand = '$HOME/.local/bin/claude --version'
        Label = 'Claude'
    }
    gemini = @{
        Type = 'gemini'
        StartupCommand = '$HOME/.local/bin/gemini'
        HealthCheckCommand = '$HOME/.local/bin/gemini --version'
        Label = 'Gemini'
    }
    shell = @{
        Type = 'shell'
        StartupCommand = $null
        Label = 'Shell'
    }
}

function Ensure-SessionCatalogFile {
    $catalogDirectory = Split-Path -Parent $sessionCatalogPath
    if (-not (Test-Path -Path $catalogDirectory)) {
        [void](New-Item -ItemType Directory -Path $catalogDirectory -Force)
    }

    if (-not (Test-Path -Path $sessionCatalogPath)) {
        Write-SessionCatalogText -Text '[]'
    }
}

function Read-SessionCatalogText {
    if (-not (Test-Path -Path $sessionCatalogPath)) {
        return ''
    }

    return (Get-Content -Path $sessionCatalogPath -Raw -Encoding utf8)
}

function Write-SessionCatalogText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    Set-Content -Path $sessionCatalogPath -Value $Text -Encoding utf8
}

function Get-SessionCatalogEntries {
    Ensure-SessionCatalogFile

    $raw = (Read-SessionCatalogText).Trim()
    if (-not $raw) {
        return @()
    }

    $parsed = $raw | ConvertFrom-Json
    if ($parsed -is [System.Array]) {
        return @($parsed)
    }
    return @($parsed)
}

function Save-SessionCatalogEntries {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Entries
    )

    Ensure-SessionCatalogFile
    if ($Entries.Count -eq 0) {
        Write-SessionCatalogText -Text '[]'
        return
    }

    Write-SessionCatalogText -Text ($Entries | ConvertTo-Json -Depth 6)
}

function Remove-ObjectPropertyIfPresent {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Object,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    $property = $Object.PSObject.Properties[$PropertyName]
    if ($property) {
        [void]$Object.PSObject.Properties.Remove($PropertyName)
    }
}

function Set-ObjectPropertyValue {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Object,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName,
        [AllowNull()]
        $Value
    )

    if ($Object.PSObject.Properties[$PropertyName]) {
        $Object.$PropertyName = $Value
    } else {
        Add-Member -InputObject $Object -NotePropertyName $PropertyName -NotePropertyValue $Value -Force
    }
}

function Get-CatalogBooleanValue {
    param(
        $Value
    )

    if ($null -eq $Value) {
        return $false
    }

    if ($Value -is [bool]) {
        return [bool]$Value
    }

    $text = [string]$Value
    return ($text -eq 'true' -or $text -eq 'True')
}

function Get-SessionCatalogEntryByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue
    )

    foreach ($entry in @(Get-SessionCatalogEntries)) {
        if ([string]$entry.session_name -eq $SessionNameValue) {
            return $entry
        }
    }

    return $null
}

function Get-SessionCatalogMap {
    $map = @{}
    foreach ($entry in @(Get-SessionCatalogEntries)) {
        $map[[string]$entry.session_name] = $entry
    }
    return $map
}

function Upsert-SessionCatalogEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue,
        [Parameter(Mandatory = $true)]
        [string]$SessionTypeValue,
        [string]$SessionTitle,
        [string]$WorkingDirectoryWindows
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(Get-SessionCatalogEntries)) {
        [void]$entries.Add($entry)
    }

    $nowUtc = (Get-Date).ToUniversalTime().ToString('o')
    $normalizedTitle = if ($SessionTitle) { $SessionTitle.Trim() } else { '' }
    $matchIndex = -1
    for ($index = 0; $index -lt $entries.Count; $index++) {
        if ([string]$entries[$index].session_name -eq $SessionNameValue) {
            $matchIndex = $index
            break
        }
    }

    if ($matchIndex -ge 0) {
        $entry = $entries[$matchIndex]
        $entry.session_type = $SessionTypeValue
        if ($normalizedTitle) {
            $entry.title = $normalizedTitle
        }
        if ($WorkingDirectoryWindows) {
            $entry.working_directory_windows = $WorkingDirectoryWindows
        }
        $entry.updated_utc = $nowUtc
        Remove-ObjectPropertyIfPresent -Object $entry -PropertyName 'closed_utc'
        $entries[$matchIndex] = $entry
    } else {
        [void]$entries.Add([pscustomobject]@{
            session_name = $SessionNameValue
            session_type = $SessionTypeValue
            title = $normalizedTitle
            working_directory_windows = $WorkingDirectoryWindows
            archived = $false
            created_utc = $nowUtc
            updated_utc = $nowUtc
        })
    }

    Save-SessionCatalogEntries -Entries @($entries)
}

function Set-SessionCatalogTitle {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue,
        [Parameter(Mandatory = $true)]
        [string]$SessionTypeValue,
        [string]$SessionTitle,
        [string]$WorkingDirectoryWindows
    )

    Upsert-SessionCatalogEntry -SessionNameValue $SessionNameValue -SessionTypeValue $SessionTypeValue -SessionTitle $SessionTitle -WorkingDirectoryWindows $WorkingDirectoryWindows
}

function Set-SessionCatalogArchivedState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue,
        [Parameter(Mandatory = $true)]
        [string]$SessionTypeValue,
        [Parameter(Mandatory = $true)]
        [bool]$Archived,
        [string]$SessionTitle,
        [string]$WorkingDirectoryWindows
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(Get-SessionCatalogEntries)) {
        [void]$entries.Add($entry)
    }

    $nowUtc = (Get-Date).ToUniversalTime().ToString('o')
    $matchIndex = -1
    for ($index = 0; $index -lt $entries.Count; $index++) {
        if ([string]$entries[$index].session_name -eq $SessionNameValue) {
            $matchIndex = $index
            break
        }
    }

    if ($matchIndex -ge 0) {
        $entry = $entries[$matchIndex]
        $entry.session_type = $SessionTypeValue
        Set-ObjectPropertyValue -Object $entry -PropertyName 'archived' -Value $Archived
        if ($SessionTitle -and $SessionTitle.Trim()) {
            $entry.title = $SessionTitle.Trim()
        }
        if ($WorkingDirectoryWindows -and $WorkingDirectoryWindows.Trim()) {
            $entry.working_directory_windows = $WorkingDirectoryWindows.Trim()
        }
        $entry.updated_utc = $nowUtc
        $entries[$matchIndex] = $entry
    } else {
        $newTitleValue = if ($SessionTitle) { $SessionTitle.Trim() } else { '' }
        $newWorkingDirectoryValue = if ($WorkingDirectoryWindows) { $WorkingDirectoryWindows.Trim() } else { '' }
        [void]$entries.Add([pscustomobject]@{
            session_name = $SessionNameValue
            session_type = $SessionTypeValue
            title = $newTitleValue
            working_directory_windows = $newWorkingDirectoryValue
            archived = $Archived
            created_utc = $nowUtc
            updated_utc = $nowUtc
        })
    }

    Save-SessionCatalogEntries -Entries @($entries)
}

function Set-SessionCatalogClosedState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue,
        [Parameter(Mandatory = $true)]
        [string]$SessionTypeValue,
        [Parameter(Mandatory = $true)]
        [bool]$Closed,
        [string]$SessionTitle,
        [string]$WorkingDirectoryWindows,
        [bool]$ArchiveOnClose = $true
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @(Get-SessionCatalogEntries)) {
        [void]$entries.Add($entry)
    }

    $nowUtc = (Get-Date).ToUniversalTime().ToString('o')
    $matchIndex = -1
    for ($index = 0; $index -lt $entries.Count; $index++) {
        if ([string]$entries[$index].session_name -eq $SessionNameValue) {
            $matchIndex = $index
            break
        }
    }

    if ($matchIndex -ge 0) {
        $entry = $entries[$matchIndex]
    } else {
        $entry = [pscustomobject]@{
            session_name = $SessionNameValue
            session_type = $SessionTypeValue
            title = ''
            working_directory_windows = ''
            archived = $false
            created_utc = $nowUtc
            updated_utc = $nowUtc
        }
        [void]$entries.Add($entry)
        $matchIndex = $entries.Count - 1
    }

    $entry.session_type = $SessionTypeValue
    if ($SessionTitle -and $SessionTitle.Trim()) {
        $entry.title = $SessionTitle.Trim()
    }
    if ($WorkingDirectoryWindows -and $WorkingDirectoryWindows.Trim()) {
        $entry.working_directory_windows = $WorkingDirectoryWindows.Trim()
    }
    if ($Closed) {
        Set-ObjectPropertyValue -Object $entry -PropertyName 'closed_utc' -Value $nowUtc
        if ($ArchiveOnClose) {
            Set-ObjectPropertyValue -Object $entry -PropertyName 'archived' -Value $true
        }
    } else {
        Remove-ObjectPropertyIfPresent -Object $entry -PropertyName 'closed_utc'
    }
    $entry.updated_utc = $nowUtc
    $entries[$matchIndex] = $entry

    Save-SessionCatalogEntries -Entries @($entries)
}

function Remove-SessionCatalogEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionNameValue
    )

    $remaining = @()
    foreach ($entry in @(Get-SessionCatalogEntries)) {
        if ([string]$entry.session_name -ne $SessionNameValue) {
            $remaining += $entry
        }
    }

    Save-SessionCatalogEntries -Entries @($remaining)
}

function New-AutoSessionLabel {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $suffix = [guid]::NewGuid().ToString('N').Substring(0, 4)
    return "auto-$timestamp-$suffix"
}

function Get-SessionPreviewText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $preview = & wsl.exe -d $TargetDistro -- bash -lc "tmux capture-pane -pt '$TargetSessionName' -S -40 2>/dev/null | grep -v '^[[:space:]]*$' | tail -n 1"
    if ($LASTEXITCODE -ne 0) {
        return ''
    }

    return (($preview | Out-String).Trim())
}

function Convert-WslPathToWindowsPath {
    param(
        [string]$WslPath
    )

    if (-not $WslPath) {
        return ''
    }

    if ($WslPath -match '^/mnt/(?<drive>[a-z])(?<rest>/.*)?$') {
        $driveLetter = $Matches['drive'].ToUpperInvariant()
        $rest = if ($Matches['rest']) { ($Matches['rest'] -replace '/', '\') } else { '' }
        return "${driveLetter}:$rest"
    }

    return $WslPath
}

function Split-SessionIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName
    )

    $match = [regex]::Match($TargetSessionName, '^(codex|claude|gemini|shell)-(.+)$')
    if (-not $match.Success) {
        return @{
            Type = 'unknown'
            DisplayName = $TargetSessionName
        }
    }

    return @{
        Type = $match.Groups[1].Value
        DisplayName = $match.Groups[2].Value
    }
}

function Get-SessionCatalogTimestampInfo {
    param(
        [string]$UtcText
    )

    if (-not $UtcText -or -not $UtcText.Trim()) {
        return @{
            Local = ''
            Unix = 0L
        }
    }

    try {
        $parsed = [DateTimeOffset]::Parse($UtcText)
        return @{
            Local = $parsed.LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss')
            Unix = [long]$parsed.ToUnixTimeSeconds()
        }
    } catch {
        return @{
            Local = ''
            Unix = 0L
        }
    }
}

function Get-SessionStateLabel {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$IsLive,
        [Parameter(Mandatory = $true)]
        [bool]$Archived,
        [string]$ClosedUtc
    )

    if ($IsLive) {
        if ($Archived) {
            return 'Running (archived)'
        }
        return 'Running'
    }

    $baseState = if ($ClosedUtc -and $ClosedUtc.Trim()) { 'Closed' } else { 'Saved' }
    if ($Archived) {
        return "$baseState (archived)"
    }
    return $baseState
}

function Get-SessionWorkingDirectoryWindows {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $panePathOutput = & wsl.exe -d $TargetDistro -- bash -lc "tmux display-message -p -t '$TargetSessionName' '#{pane_current_path}' 2>/dev/null"
    if ($LASTEXITCODE -ne 0) {
        return ''
    }

    $panePath = ($panePathOutput | Out-String).Trim()
    if (-not $panePath) {
        return ''
    }

    return Convert-WslPathToWindowsPath -WslPath $panePath
}

function Get-DefaultSessionTitle {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Session
    )

    $typeKey = [string]$Session.Type
    $typeLabel = if ($profiles.ContainsKey($typeKey)) { [string]$profiles[$typeKey].Label } else { 'Session' }
    $createdValue = if ($Session.PSObject.Properties.Name -contains 'CreatedLocal') { [string]$Session.CreatedLocal } else { '' }

    if ($createdValue.Trim()) {
        return "$typeLabel $createdValue"
    }

    return "$typeLabel session"
}

function Test-IsMeaningfulPreviewText {
    param(
        [string]$PreviewText
    )

    $trimmed = if ($PreviewText) { $PreviewText.Trim() } else { '' }
    if (-not $trimmed) {
        return $false
    }

    if ($trimmed -match '^[^@\s]+@[^:]+:.*[$#]$') {
        return $false
    }

    return $true
}

function Get-SessionDisplayTitle {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Session
    )

    if ($Session.PSObject.Properties.Name -contains 'Title') {
        $titleValue = [string]$Session.Title
        if ($titleValue.Trim()) {
            return $titleValue.Trim()
        }
    }

    $fallbackLabel = [string]$Session.DisplayName
    if ($fallbackLabel.Trim() -and -not $fallbackLabel.Trim().StartsWith('auto-')) {
        return $fallbackLabel.Trim()
    }

    if ($Session.PSObject.Properties.Name -contains 'PreviewText') {
        $previewValue = [string]$Session.PreviewText
        if (Test-IsMeaningfulPreviewText -PreviewText $previewValue) {
            return $previewValue.Trim()
        }
    }

    return Get-DefaultSessionTitle -Session $Session
}

function Test-WslCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    & wsl.exe -d $TargetDistro -- bash -lc "$Command >/dev/null 2>&1"
    return ($LASTEXITCODE -eq 0)
}

function Resolve-WindowsWorkingDirectory {
    param(
        [string]$PathText
    )

    $candidate = if ($PathText -and $PathText.Trim()) { $PathText.Trim() } else { $workspaceRootPath }
    $resolved = [System.IO.Path]::GetFullPath($candidate)

    if (-not (Test-Path -Path $resolved -PathType Container)) {
        throw "Working directory not found: $resolved"
    }

    return $resolved
}

function Convert-WindowsPathToWslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WindowsPath,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    if ($WindowsPath -match '^(?<drive>[A-Za-z]):(?<rest>\\.*)?$') {
        $driveLetter = $Matches['drive'].ToLowerInvariant()
        $rest = if ($Matches['rest']) { ($Matches['rest'] -replace '\\', '/') } else { '' }
        return "/mnt/$driveLetter$rest"
    }

    if ($WindowsPath.StartsWith('/')) {
        return $WindowsPath
    }

    $wslPathOutput = & wsl.exe -d $TargetDistro -- wslpath -a -u $WindowsPath
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to convert Windows path to WSL path: $WindowsPath"
    }

    $wslPath = ($wslPathOutput | Out-String).Trim()
    if (-not $wslPath) {
        throw "WSL path conversion returned empty output for: $WindowsPath"
    }

    return $wslPath
}

function Get-WorkspaceDirectorySuggestions {
    $ordered = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($pathValue in @($workspaceRootPath)) {
        if ($pathValue -and $seen.Add($pathValue)) {
            [void]$ordered.Add($pathValue)
        }
    }

    foreach ($entry in @(Get-SessionCatalogEntries)) {
        if ($entry.PSObject.Properties.Name -contains 'working_directory_windows') {
            $pathValue = [string]$entry.working_directory_windows
            if ($pathValue -and (Test-Path -Path $pathValue -PathType Container) -and $seen.Add($pathValue)) {
                [void]$ordered.Add($pathValue)
            }
        }
    }

    $childDirectories = @(Get-ChildItem -Path $workspaceRootPath -Directory -ErrorAction SilentlyContinue | Sort-Object -Property Name)
    foreach ($directory in $childDirectories) {
        $pathValue = $directory.FullName
        if ($seen.Add($pathValue)) {
            [void]$ordered.Add($pathValue)
        }
    }

    return @($ordered)
}

function Invoke-TmuxScript {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Parameters
    )

    & $tmuxScriptPath @Parameters
    if ($LASTEXITCODE -ne 0) {
        throw "wsl-tmux.ps1 failed with exit code $LASTEXITCODE."
    }
}

function Sync-CodexAuthForWsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $captured = & pwsh.exe -NoProfile -ExecutionPolicy Bypass -File $codexAuthSyncScriptPath -Distro $TargetDistro -Json 2>&1
    if ($LASTEXITCODE -ne 0) {
        $detail = (($captured | Out-String).Trim())
        if (-not $detail) {
            $detail = "Exit code $LASTEXITCODE."
        }
        throw "Failed to synchronize Codex auth for WSL startup. $detail"
    }
}

function Get-ProfileLaunchSettings {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfileName,
        [Parameter(Mandatory = $true)]
        [string]$SessionLabel,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro,
        [switch]$SuppressStartup
    )

    $profile = $profiles[$ProfileName]
    if (-not $profile) {
        throw "Unknown profile '$ProfileName'."
    }

    $startupCommand = if ($profile.ContainsKey('StartupCommand')) { $profile['StartupCommand'] } else { $null }
    $healthCheckCommand = if ($profile.ContainsKey('HealthCheckCommand')) { [string]$profile['HealthCheckCommand'] } else { '' }
    $fallbackMessage = $null

    if ($SuppressStartup) {
        $startupCommand = $null
    } elseif ($startupCommand -and $healthCheckCommand) {
        $isHealthy = Test-WslCommand -Command $healthCheckCommand -TargetDistro $TargetDistro
        if (-not $isHealthy) {
            $startupCommand = $null
            $fallbackMessage = "$($profile.Label) startup command is not runnable in WSL distro '$TargetDistro'. A plain shell session will be opened for this typed session."
        }
    }

    return @{
        SessionType = [string]$profile.Type
        SessionLabel = $SessionLabel
        StartupCommand = $startupCommand
        FallbackMessage = $fallbackMessage
    }
}

function Invoke-EnsureTypedSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionType,
        [Parameter(Mandatory = $true)]
        [string]$SessionLabel,
        [string]$StartupCommand,
        [string]$WorkingDirectoryPath,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro,
        [switch]$NoAttach
    )

    $params = @{
        Action = 'ensure'
        Distro = $TargetDistro
        SessionType = $SessionType
        SessionLabel = $SessionLabel
    }

    if ($StartupCommand) {
        $params.StartupCommand = $StartupCommand
    }
    if ($WorkingDirectoryPath) {
        $params.WorkingDirectory = $WorkingDirectoryPath
    }
    if ($NoAttach) {
        $params.Detach = $true
    }

    Invoke-TmuxScript -Parameters $params
}

function Invoke-AttachSessionByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    Invoke-TmuxScript -Parameters @{
        Action = 'attach'
        Distro = $TargetDistro
        SessionName = $TargetSessionName
    }
}

function Ensure-ManagedSessionLiveUpdates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    Invoke-TmuxScript -Parameters @{
        Action = 'ensure-live-updates'
        Distro = $TargetDistro
        SessionName = $TargetSessionName
    } | Out-Null
}

function Get-ExistingSessions {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro,
        [switch]$IncludeCatalogOnly
    )

    $jsonText = & $tmuxScriptPath -Action list -Distro $TargetDistro -Json
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to retrieve tmux sessions.'
    }

    $raw = ($jsonText | Out-String).Trim()
    $liveSessions = @()
    if ($raw) {
        $parsed = $raw | ConvertFrom-Json
        $liveSessions = if ($parsed -is [System.Array]) { @($parsed) } else { @($parsed) }
    }
    $catalogMap = Get-SessionCatalogMap
    $results = [System.Collections.Generic.List[object]]::new()
    $seenSessionNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($session in $liveSessions) {
        $sessionNameValue = [string]$session.Name
        [void]$seenSessionNames.Add($sessionNameValue)
        $metadata = $catalogMap[$sessionNameValue]
        $previewText = Get-SessionPreviewText -TargetSessionName $sessionNameValue -TargetDistro $TargetDistro
        $titleValue = if ($metadata) { [string]$metadata.title } else { '' }
        $workingDirectoryValue = if ($metadata -and $metadata.PSObject.Properties.Name -contains 'working_directory_windows') { [string]$metadata.working_directory_windows } else { '' }
        $archivedValue = if ($metadata -and $metadata.PSObject.Properties.Name -contains 'archived') { Get-CatalogBooleanValue -Value $metadata.archived } else { $false }
        $closedUtcValue = if ($metadata -and $metadata.PSObject.Properties.Name -contains 'closed_utc') { [string]$metadata.closed_utc } else { '' }
        if (-not $workingDirectoryValue) {
            $workingDirectoryValue = Get-SessionWorkingDirectoryWindows -TargetSessionName $sessionNameValue -TargetDistro $TargetDistro
        }
        Add-Member -InputObject $session -NotePropertyName 'Title' -NotePropertyValue $titleValue -Force
        Add-Member -InputObject $session -NotePropertyName 'WorkingDirectoryWindows' -NotePropertyValue $workingDirectoryValue -Force
        Add-Member -InputObject $session -NotePropertyName 'PreviewText' -NotePropertyValue $previewText -Force
        Add-Member -InputObject $session -NotePropertyName 'Archived' -NotePropertyValue $archivedValue -Force
        Add-Member -InputObject $session -NotePropertyName 'ClosedUtc' -NotePropertyValue $closedUtcValue -Force
        Add-Member -InputObject $session -NotePropertyName 'IsLive' -NotePropertyValue $true -Force
        Add-Member -InputObject $session -NotePropertyName 'State' -NotePropertyValue (Get-SessionStateLabel -IsLive $true -Archived $archivedValue -ClosedUtc $closedUtcValue) -Force
        Add-Member -InputObject $session -NotePropertyName 'SortUnix' -NotePropertyValue ([long]$session.LastActivityUnix) -Force
        Add-Member -InputObject $session -NotePropertyName 'DisplayTitle' -NotePropertyValue (Get-SessionDisplayTitle -Session $session) -Force
        [void]$results.Add($session)
    }

    if ($IncludeCatalogOnly) {
        foreach ($entry in @(Get-SessionCatalogEntries)) {
            $sessionNameValue = [string]$entry.session_name
            if (-not $sessionNameValue -or $seenSessionNames.Contains($sessionNameValue)) {
                continue
            }

            $identity = Split-SessionIdentity -TargetSessionName $sessionNameValue
            $closedUtcValue = if ($entry.PSObject.Properties.Name -contains 'closed_utc') { [string]$entry.closed_utc } else { '' }
            $timestampInfo = if ($closedUtcValue) { Get-SessionCatalogTimestampInfo -UtcText $closedUtcValue } elseif ($entry.PSObject.Properties.Name -contains 'updated_utc') { Get-SessionCatalogTimestampInfo -UtcText ([string]$entry.updated_utc) } else { Get-SessionCatalogTimestampInfo -UtcText '' }
            $createdUtcValue = if ($entry.PSObject.Properties.Name -contains 'created_utc') { [string]$entry.created_utc } else { '' }
            $createdInfo = Get-SessionCatalogTimestampInfo -UtcText $createdUtcValue
            $archivedValue = if ($entry.PSObject.Properties.Name -contains 'archived') { Get-CatalogBooleanValue -Value $entry.archived } else { $false }
            $catalogSessionType = if ($entry.PSObject.Properties.Name -contains 'session_type' -and [string]$entry.session_type) { [string]$entry.session_type } else { [string]$identity.Type }
            $catalogTitleValue = if ($entry.PSObject.Properties.Name -contains 'title') { [string]$entry.title } else { '' }
            $catalogWorkingDirectoryValue = if ($entry.PSObject.Properties.Name -contains 'working_directory_windows') { [string]$entry.working_directory_windows } else { '' }
            $session = [pscustomobject]@{
                Name = $sessionNameValue
                Type = $catalogSessionType
                DisplayName = [string]$identity.DisplayName
                Distro = $TargetDistro
                CreatedUnix = [long]$createdInfo.Unix
                CreatedLocal = [string]$createdInfo.Local
                AttachedClients = 0
                WindowCount = 0
                LastActivityUnix = [long]$timestampInfo.Unix
                LastActivityLocal = [string]$timestampInfo.Local
                Title = $catalogTitleValue
                WorkingDirectoryWindows = $catalogWorkingDirectoryValue
                PreviewText = ''
                Archived = $archivedValue
                ClosedUtc = $closedUtcValue
                IsLive = $false
                State = Get-SessionStateLabel -IsLive $false -Archived $archivedValue -ClosedUtc $closedUtcValue
                SortUnix = [long]$timestampInfo.Unix
            }
            Add-Member -InputObject $session -NotePropertyName 'DisplayTitle' -NotePropertyValue (Get-SessionDisplayTitle -Session $session) -Force
            [void]$results.Add($session)
        }
    }

    return @($results | Sort-Object -Property @(@{ Expression = 'SortUnix'; Descending = $true }, 'DisplayTitle'))
}

function Get-SessionRecordByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    foreach ($session in @(Get-ExistingSessions -TargetDistro $TargetDistro -IncludeCatalogOnly)) {
        if ([string]$session.Name -eq $TargetSessionName) {
            return $session
        }
    }

    return $null
}

function Invoke-KillSessionByName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    Invoke-TmuxScript -Parameters @{
        Action = 'kill'
        Distro = $TargetDistro
        SessionName = $TargetSessionName
    }
}

function Set-ManagedSessionTitle {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetTitle,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $session = Get-SessionRecordByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    if (-not $session) {
        throw "Session '$TargetSessionName' was not found."
    }

    Set-SessionCatalogTitle -SessionNameValue $TargetSessionName -SessionTypeValue ([string]$session.Type) -SessionTitle $TargetTitle -WorkingDirectoryWindows ([string]$session.WorkingDirectoryWindows)
}

function Set-ManagedSessionArchivedState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [bool]$Archived,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $session = Get-SessionRecordByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    if (-not $session) {
        throw "Session '$TargetSessionName' was not found."
    }

    Set-SessionCatalogArchivedState -SessionNameValue $TargetSessionName -SessionTypeValue ([string]$session.Type) -Archived $Archived -SessionTitle ([string]$session.Title) -WorkingDirectoryWindows ([string]$session.WorkingDirectoryWindows)
}

function Close-ManagedSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $session = Get-SessionRecordByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    if (-not $session) {
        throw "Session '$TargetSessionName' was not found."
    }

    if ([bool]$session.IsLive) {
        Invoke-KillSessionByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    }

    Set-SessionCatalogClosedState -SessionNameValue $TargetSessionName -SessionTypeValue ([string]$session.Type) -Closed $true -SessionTitle ([string]$session.Title) -WorkingDirectoryWindows ([string]$session.WorkingDirectoryWindows)
}

function Remove-ManagedSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $session = Get-SessionRecordByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    if ($session -and [bool]$session.IsLive) {
        Invoke-KillSessionByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    }

    Remove-SessionCatalogEntry -SessionNameValue $TargetSessionName
}

function Test-ExistingSessionName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $session = Get-SessionRecordByName -TargetSessionName $TargetSessionName -TargetDistro $TargetDistro
    return ($session -and [bool]$session.IsLive)
}

function Resolve-TypedSessionName {
    param(
        [string]$TargetSessionName,
        [string]$TargetType,
        [string]$TargetName
    )

    if ($TargetSessionName) {
        return $TargetSessionName
    }

    if ($TargetType -and $TargetName -and $TargetName.Trim()) {
        $safe = $TargetName.Trim().ToLowerInvariant() -replace '[^a-z0-9._-]+', '-'
        $safe = $safe.Trim('-')
        if (-not $safe) {
            throw 'Name is not valid after normalization.'
        }
        return "$TargetType-$safe"
    }

    return ''
}

function Start-ProfileSession {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('codex', 'claude', 'gemini', 'shell')]
        [string]$ProfileName,
        [string]$SessionLabel,
        [string]$SessionTitle,
        [string]$WindowsWorkingDirectory,
        [switch]$NoStartup,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $resolvedSessionLabel = if ($SessionLabel -and $SessionLabel.Trim()) { $SessionLabel } else { New-AutoSessionLabel }
    $resolvedWindowsWorkingDirectory = Resolve-WindowsWorkingDirectory -PathText $WindowsWorkingDirectory
    $resolvedWslWorkingDirectory = Convert-WindowsPathToWslPath -WindowsPath $resolvedWindowsWorkingDirectory -TargetDistro $TargetDistro

    $settings = Get-ProfileLaunchSettings -ProfileName $ProfileName -SessionLabel $resolvedSessionLabel -TargetDistro $TargetDistro -SuppressStartup:$NoStartup
    if ($settings.FallbackMessage) {
        Write-Warning $settings.FallbackMessage
    }

    $resolvedSessionName = "$($settings.SessionType)-$($settings.SessionLabel.ToLowerInvariant())"
    if ($ProfileName -eq 'codex') {
        Sync-CodexAuthForWsl -TargetDistro $TargetDistro
    }
    Upsert-SessionCatalogEntry -SessionNameValue $resolvedSessionName -SessionTypeValue $settings.SessionType -SessionTitle $SessionTitle -WorkingDirectoryWindows $resolvedWindowsWorkingDirectory
    Invoke-EnsureTypedSession -SessionType $settings.SessionType -SessionLabel $settings.SessionLabel -StartupCommand $settings.StartupCommand -WorkingDirectoryPath $resolvedWslWorkingDirectory -TargetDistro $TargetDistro -NoAttach:$Detach
}

function Read-Choice {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt,
        [Parameter(Mandatory = $true)]
        [string[]]$Allowed
    )

    while ($true) {
        $value = [string](Read-Host $Prompt)
        if ($Allowed -contains $value) {
            return $value
        }
        Write-Host "Invalid choice. Allowed values: $($Allowed -join ', ')"
    }
}

function Select-ExistingSessionInteractive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $sessions = @(Get-ExistingSessions -TargetDistro $TargetDistro)
    if ($sessions.Count -eq 0) {
        throw "No tmux sessions found in distro '$TargetDistro'."
    }

    for ($i = 0; $i -lt $sessions.Count; $i++) {
        $s = $sessions[$i]
        $index = $i + 1
        $displayTitle = Get-SessionDisplayTitle -Session $s
        $previewText = [string]$s.PreviewText
        Write-Host ("[{0}] {1}  type={2}  preview={3}  attached={4}  windows={5}  activity={6}" -f $index, $displayTitle, $s.Type, $previewText, $s.AttachedClients, $s.WindowCount, $s.LastActivityLocal)
    }

    while ($true) {
        $choiceText = [string](Read-Host 'Select session number')
        $choice = 0
        if ([int]::TryParse($choiceText, [ref]$choice)) {
            if ($choice -ge 1 -and $choice -le $sessions.Count) {
                return [string]$sessions[$choice - 1].Name
            }
        }
        Write-Host 'Invalid number.'
    }
}

function Open-PlainWslShell {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    & wsl.exe -d $TargetDistro
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to open plain WSL shell for distro '$TargetDistro'."
    }
}

function Start-MobileFlow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    while ($true) {
        Write-Host "AI session mobile menu (distro: $TargetDistro)"
        Write-Host '[1] Start new typed session'
        Write-Host '[2] Resume existing session'
        Write-Host '[3] List sessions'
        Write-Host '[4] Open plain WSL shell'
        Write-Host '[5] Exit'
        $menuChoice = Read-Choice -Prompt 'Choose 1/2/3/4/5' -Allowed @('1', '2', '3', '4', '5')

        if ($menuChoice -eq '1') {
            $typeChoice = Read-Choice -Prompt 'Type (codex/claude/gemini/shell)' -Allowed @('codex', 'claude', 'gemini', 'shell')
            $sessionTitle = [string](Read-Host 'What is this session about? (optional)')
            $sessionWorkingDirectory = [string](Read-Host "Working directory (optional, default: $workspaceRootPath)")
            Start-ProfileSession -ProfileName $typeChoice -SessionTitle $sessionTitle -WindowsWorkingDirectory $sessionWorkingDirectory -TargetDistro $TargetDistro
            continue
        }

        if ($menuChoice -eq '2') {
            $selectedName = Select-ExistingSessionInteractive -TargetDistro $TargetDistro
            Invoke-AttachSessionByName -TargetSessionName $selectedName -TargetDistro $TargetDistro
            continue
        }

        if ($menuChoice -eq '3') {
            $items = @(Get-ExistingSessions -TargetDistro $TargetDistro)
            if ($Json) {
                if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Depth 4 }
                return
            }

            if ($items.Count -eq 0) {
                Write-Host 'No sessions found.'
            } else {
                $items | Format-Table DisplayTitle, Type, WorkingDirectoryWindows, PreviewText, AttachedClients, WindowCount, LastActivityLocal -AutoSize
            }
            continue
        }

        if ($menuChoice -eq '4') {
            Open-PlainWslShell -TargetDistro $TargetDistro
            continue
        }

        return
    }
}

if ($Mode -eq 'list') {
    $items = @(Get-ExistingSessions -TargetDistro $Distro -IncludeCatalogOnly:$IncludeArchived)
    if (-not $IncludeArchived) {
        $items = @($items | Where-Object { $_.IsLive -and (-not $_.Archived) })
    }
    if ($Json) {
        if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Depth 4 }
    } else {
        $items | Format-Table DisplayTitle, Type, State, WorkingDirectoryWindows, PreviewText, AttachedClients, WindowCount, LastActivityLocal -AutoSize
    }
    exit 0
}

if ($Mode -eq 'new' -or $Mode -eq 'start') {
    if (-not $Type) {
        throw 'Use -Type with -Mode new/start.'
    }
    Start-ProfileSession -ProfileName $Type -SessionLabel $Name -SessionTitle $Title -WindowsWorkingDirectory $WorkingDirectory -TargetDistro $Distro -NoStartup:$NoStartup
    exit 0
}

if ($Mode -eq 'resume' -or $Mode -eq 'existing') {
    $resolvedResumeName = Resolve-TypedSessionName -TargetSessionName $SessionName -TargetType $Type -TargetName $Name
    if ($resolvedResumeName) {
        if ($Detach) {
            if (-not (Test-ExistingSessionName -TargetSessionName $resolvedResumeName -TargetDistro $Distro)) {
                throw "Session '$resolvedResumeName' not found in distro '$Distro'."
            }
            Write-Output "Session '$resolvedResumeName' is available in distro '$Distro'."
        } else {
            Invoke-AttachSessionByName -TargetSessionName $resolvedResumeName -TargetDistro $Distro
        }
    } else {
        $selectedName = Select-ExistingSessionInteractive -TargetDistro $Distro
        Invoke-AttachSessionByName -TargetSessionName $selectedName -TargetDistro $Distro
    }
    exit 0
}

if ($Mode -eq 'rename') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Mode rename.'
    }
    if (-not $Title -or -not $Title.Trim()) {
        throw 'Use -Title with -Mode rename.'
    }
    Set-ManagedSessionTitle -TargetSessionName $SessionName -TargetTitle $Title -TargetDistro $Distro
    exit 0
}

if ($Mode -eq 'archive') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Mode archive.'
    }
    Set-ManagedSessionArchivedState -TargetSessionName $SessionName -Archived $true -TargetDistro $Distro
    exit 0
}

if ($Mode -eq 'unarchive') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Mode unarchive.'
    }
    Set-ManagedSessionArchivedState -TargetSessionName $SessionName -Archived $false -TargetDistro $Distro
    exit 0
}

if ($Mode -eq 'close') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Mode close.'
    }
    Close-ManagedSession -TargetSessionName $SessionName -TargetDistro $Distro
    exit 0
}

if ($Mode -eq 'delete') {
    if (-not $SessionName) {
        throw 'Use -SessionName with -Mode delete.'
    }
    Remove-ManagedSession -TargetSessionName $SessionName -TargetDistro $Distro
    exit 0
}

if ($Mode -eq 'mobile') {
    if ($Type -and $Name.Trim()) {
        Start-ProfileSession -ProfileName $Type -SessionLabel $Name -SessionTitle $Title -WindowsWorkingDirectory $WorkingDirectory -TargetDistro $Distro
        exit 0
    }
    if ($Type -and $Title.Trim()) {
        Start-ProfileSession -ProfileName $Type -SessionTitle $Title -WindowsWorkingDirectory $WorkingDirectory -TargetDistro $Distro
        exit 0
    }
    $resolvedMobileResumeName = Resolve-TypedSessionName -TargetSessionName $SessionName -TargetType $Type -TargetName $Name
    if ($resolvedMobileResumeName) {
        if ($Detach) {
            if (-not (Test-ExistingSessionName -TargetSessionName $resolvedMobileResumeName -TargetDistro $Distro)) {
                throw "Session '$resolvedMobileResumeName' not found in distro '$Distro'."
            }
            Write-Output "Session '$resolvedMobileResumeName' is available in distro '$Distro'."
        } else {
            Invoke-AttachSessionByName -TargetSessionName $resolvedMobileResumeName -TargetDistro $Distro
        }
        exit 0
    }
    Start-MobileFlow -TargetDistro $Distro
    exit 0
}

if ($Mode -ne 'gui') {
    Start-ProfileSession -ProfileName $Mode -SessionLabel $Name -SessionTitle $Title -WindowsWorkingDirectory $WorkingDirectory -TargetDistro $Distro
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

function Open-TmuxInNewWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$ScriptArguments
    )

    $terminalArgs = @(
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-File', $tmuxScriptPath
    ) + $ScriptArguments

    $pwsh = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
    $shellPath = if ($pwsh) { $pwsh.Source } else { (Get-Command 'powershell.exe' -ErrorAction Stop).Source }

    Start-Process -FilePath $shellPath -ArgumentList $terminalArgs | Out-Null
}

function New-GuiProfileSession {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('codex', 'claude', 'gemini', 'shell')]
        [string]$ProfileName,
        [string]$SessionTitle,
        [string]$WindowsWorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    $resolvedSessionLabel = New-AutoSessionLabel
    $resolvedWindowsWorkingDirectory = Resolve-WindowsWorkingDirectory -PathText $WindowsWorkingDirectory
    $resolvedWslWorkingDirectory = Convert-WindowsPathToWslPath -WindowsPath $resolvedWindowsWorkingDirectory -TargetDistro $TargetDistro

    $settings = Get-ProfileLaunchSettings -ProfileName $ProfileName -SessionLabel $resolvedSessionLabel -TargetDistro $TargetDistro
    if ($settings.FallbackMessage) {
        [System.Windows.Forms.MessageBox]::Show(
            $settings.FallbackMessage,
            "$($profiles[$ProfileName].Label) Fallback",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
    }

    Upsert-SessionCatalogEntry -SessionNameValue "$($settings.SessionType)-$($settings.SessionLabel.ToLowerInvariant())" -SessionTypeValue $settings.SessionType -SessionTitle $SessionTitle -WorkingDirectoryWindows $resolvedWindowsWorkingDirectory
    $scriptArgs = @(
        '-Action', 'ensure',
        '-Distro', $TargetDistro,
        '-SessionType', $settings.SessionType,
        '-SessionLabel', $settings.SessionLabel,
        '-WorkingDirectory', $resolvedWslWorkingDirectory
    )

    if ($settings.StartupCommand) {
        $scriptArgs += @('-StartupCommand', $settings.StartupCommand)
    }

    Open-TmuxInNewWindow -ScriptArguments $scriptArgs
}

function Open-GuiExistingSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetSessionName,
        [Parameter(Mandatory = $true)]
        [string]$TargetDistro
    )

    Open-TmuxInNewWindow -ScriptArguments @(
        '-Action', 'attach',
        '-Distro', $TargetDistro,
        '-SessionName', $TargetSessionName
    )
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI Agent Hub'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(960, 520)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = 'Start Or Resume Agent Sessions'
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$titleLabel.AutoSize = $true
$titleLabel.Location = New-Object System.Drawing.Point(20, 16)
$form.Controls.Add($titleLabel)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Distro: $Distro. Internal IDs are generated automatically. Choose a folder first, then optionally add a short topic."
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(20, 48)
$form.Controls.Add($hint)

$newGroup = New-Object System.Windows.Forms.GroupBox
$newGroup.Text = 'Start New Session'
$newGroup.Location = New-Object System.Drawing.Point(20, 80)
$newGroup.Size = New-Object System.Drawing.Size(920, 160)
$form.Controls.Add($newGroup)

$typeLabel = New-Object System.Windows.Forms.Label
$typeLabel.Text = 'Agent Type'
$typeLabel.AutoSize = $true
$typeLabel.Location = New-Object System.Drawing.Point(18, 32)
$newGroup.Controls.Add($typeLabel)

$typeCombo = New-Object System.Windows.Forms.ComboBox
$typeCombo.DropDownStyle = 'DropDownList'
$typeCombo.Location = New-Object System.Drawing.Point(18, 54)
$typeCombo.Size = New-Object System.Drawing.Size(160, 28)
[void]$typeCombo.Items.AddRange(@('codex', 'claude', 'gemini', 'shell'))
$typeCombo.SelectedIndex = 0
$newGroup.Controls.Add($typeCombo)

$directoryLabel = New-Object System.Windows.Forms.Label
$directoryLabel.Text = 'Directory'
$directoryLabel.AutoSize = $true
$directoryLabel.Location = New-Object System.Drawing.Point(208, 32)
$newGroup.Controls.Add($directoryLabel)

$directoryCombo = New-Object System.Windows.Forms.ComboBox
$directoryCombo.DropDownStyle = 'DropDown'
$directoryCombo.Location = New-Object System.Drawing.Point(208, 54)
$directoryCombo.Size = New-Object System.Drawing.Size(540, 28)
$directoryCombo.Text = $workspaceRootPath
$directoryCombo.AutoCompleteMode = 'SuggestAppend'
$directoryCombo.AutoCompleteSource = 'ListItems'
$newGroup.Controls.Add($directoryCombo)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = 'Browse...'
$browseButton.Location = New-Object System.Drawing.Point(766, 52)
$browseButton.Size = New-Object System.Drawing.Size(120, 32)
$newGroup.Controls.Add($browseButton)

$nameLabel = New-Object System.Windows.Forms.Label
$nameLabel.Text = 'What Is This About?'
$nameLabel.AutoSize = $true
$nameLabel.Location = New-Object System.Drawing.Point(18, 98)
$newGroup.Controls.Add($nameLabel)

$nameBox = New-Object System.Windows.Forms.TextBox
$nameBox.Location = New-Object System.Drawing.Point(18, 120)
$nameBox.Size = New-Object System.Drawing.Size(730, 28)
$nameBox.Text = ''
$newGroup.Controls.Add($nameBox)

$createButton = New-Object System.Windows.Forms.Button
$createButton.Text = 'Start New Session'
$createButton.Location = New-Object System.Drawing.Point(766, 118)
$createButton.Size = New-Object System.Drawing.Size(120, 32)
$newGroup.Controls.Add($createButton)

$existingGroup = New-Object System.Windows.Forms.GroupBox
$existingGroup.Text = 'Resume Existing Session'
$existingGroup.Location = New-Object System.Drawing.Point(20, 256)
$existingGroup.Size = New-Object System.Drawing.Size(920, 216)
$form.Controls.Add($existingGroup)

$sessionList = New-Object System.Windows.Forms.ListView
$sessionList.Location = New-Object System.Drawing.Point(18, 30)
$sessionList.Size = New-Object System.Drawing.Size(880, 138)
$sessionList.View = [System.Windows.Forms.View]::Details
$sessionList.FullRowSelect = $true
$sessionList.GridLines = $true
[void]$sessionList.Columns.Add('Title', 200)
[void]$sessionList.Columns.Add('Type', 70)
[void]$sessionList.Columns.Add('State', 120)
[void]$sessionList.Columns.Add('Folder', 230)
[void]$sessionList.Columns.Add('Preview', 150)
[void]$sessionList.Columns.Add('Attached', 70)
[void]$sessionList.Columns.Add('Last Activity', 120)
$existingGroup.Controls.Add($sessionList)

$showArchivedCheckBox = New-Object System.Windows.Forms.CheckBox
$showArchivedCheckBox.Text = 'Show Archived / Closed'
$showArchivedCheckBox.AutoSize = $true
$showArchivedCheckBox.Location = New-Object System.Drawing.Point(18, 181)
$existingGroup.Controls.Add($showArchivedCheckBox)

$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = 'Refresh'
$refreshButton.Location = New-Object System.Drawing.Point(194, 176)
$refreshButton.Size = New-Object System.Drawing.Size(88, 30)
$existingGroup.Controls.Add($refreshButton)

$renameButton = New-Object System.Windows.Forms.Button
$renameButton.Text = 'Rename Title'
$renameButton.Location = New-Object System.Drawing.Point(300, 176)
$renameButton.Size = New-Object System.Drawing.Size(100, 30)
$renameButton.Enabled = $false
$existingGroup.Controls.Add($renameButton)

$archiveButton = New-Object System.Windows.Forms.Button
$archiveButton.Text = 'Archive'
$archiveButton.Location = New-Object System.Drawing.Point(418, 176)
$archiveButton.Size = New-Object System.Drawing.Size(90, 30)
$archiveButton.Enabled = $false
$existingGroup.Controls.Add($archiveButton)

$closeSessionButton = New-Object System.Windows.Forms.Button
$closeSessionButton.Text = 'Close Session'
$closeSessionButton.Location = New-Object System.Drawing.Point(526, 176)
$closeSessionButton.Size = New-Object System.Drawing.Size(102, 30)
$closeSessionButton.Enabled = $false
$existingGroup.Controls.Add($closeSessionButton)

$deleteSessionButton = New-Object System.Windows.Forms.Button
$deleteSessionButton.Text = 'Delete'
$deleteSessionButton.Location = New-Object System.Drawing.Point(646, 176)
$deleteSessionButton.Size = New-Object System.Drawing.Size(88, 30)
$deleteSessionButton.Enabled = $false
$existingGroup.Controls.Add($deleteSessionButton)

$resumeButton = New-Object System.Windows.Forms.Button
$resumeButton.Text = 'Open Selected'
$resumeButton.Location = New-Object System.Drawing.Point(752, 176)
$resumeButton.Size = New-Object System.Drawing.Size(146, 30)
$resumeButton.Enabled = $false
$existingGroup.Controls.Add($resumeButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = 'Close'
$closeButton.Width = 100
$closeButton.Height = 34
$closeButton.Location = New-Object System.Drawing.Point(840, 480)
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

$autoRefreshTimer = New-Object System.Windows.Forms.Timer
$autoRefreshTimer.Interval = 2500
$guiRefreshInProgress = $false
$lastGuiSessionSignature = ''

$doubleBufferProperty = $sessionList.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic)
if ($doubleBufferProperty) {
    $doubleBufferProperty.SetValue($sessionList, $true, $null)
}

function Refresh-GuiDirectorySuggestions {
    $selectedText = [string]$directoryCombo.Text
    $directoryCombo.Items.Clear()
    foreach ($pathValue in @(Get-WorkspaceDirectorySuggestions)) {
        [void]$directoryCombo.Items.Add($pathValue)
    }
    if ($selectedText.Trim()) {
        $directoryCombo.Text = $selectedText
    } else {
        $directoryCombo.Text = $workspaceRootPath
    }
}

function Update-GuiSelectionState {
    $selectedItem = if ($sessionList.SelectedItems.Count -gt 0) { $sessionList.SelectedItems[0] } else { $null }
    if (-not $selectedItem) {
        $renameButton.Enabled = $false
        $archiveButton.Enabled = $false
        $closeSessionButton.Enabled = $false
        $deleteSessionButton.Enabled = $false
        $resumeButton.Enabled = $false
        $archiveButton.Text = 'Archive'
        return
    }

    $isLive = [bool]$selectedItem.SubItems[5].Tag
    $isArchived = [bool]$selectedItem.SubItems[2].Tag
    $renameButton.Enabled = $true
    $archiveButton.Enabled = $true
    $closeSessionButton.Enabled = $isLive
    $deleteSessionButton.Enabled = $true
    $resumeButton.Enabled = $isLive
    $archiveButton.Text = if ($isArchived) { 'Unarchive' } else { 'Archive' }
}

function Get-GuiSessionListSignature {
    $sessions = @(Get-ExistingSessions -TargetDistro $Distro -IncludeCatalogOnly)
    if ($sessions.Count -eq 0) {
        return ''
    }

    $parts = foreach ($s in $sessions) {
        '{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $s.Name, $s.Type, $s.State, $s.Archived, $s.IsLive, $s.DisplayTitle, $s.LastActivityLocal
    }
    return (($parts | Sort-Object) -join "`n")
}

function Refresh-GuiSessions {
    param(
        [switch]$Force
    )

    if ($guiRefreshInProgress) {
        return
    }

    $guiRefreshInProgress = $true
    try {
        $signature = Get-GuiSessionListSignature
        if (-not $Force -and $signature -eq $lastGuiSessionSignature) {
            return
        }

        $selectedTag = ''
        if ($sessionList.SelectedItems.Count -gt 0) {
            $selectedTag = [string]$sessionList.SelectedItems[0].Tag
        }

        $sessions = @(Get-ExistingSessions -TargetDistro $Distro -IncludeCatalogOnly:$showArchivedCheckBox.Checked)
        if (-not $showArchivedCheckBox.Checked) {
            $sessions = @($sessions | Where-Object { $_.IsLive -and (-not $_.Archived) })
        }
        $sessionList.BeginUpdate()
        try {
            $sessionList.Items.Clear()
            foreach ($s in $sessions) {
                $item = New-Object System.Windows.Forms.ListViewItem((Get-SessionDisplayTitle -Session $s))
                [void]$item.SubItems.Add([string]$s.Type)
                [void]$item.SubItems.Add([string]$s.State)
                [void]$item.SubItems.Add([string]$s.WorkingDirectoryWindows)
                [void]$item.SubItems.Add([string]$s.PreviewText)
                [void]$item.SubItems.Add([string]$s.AttachedClients)
                [void]$item.SubItems.Add([string]$s.LastActivityLocal)
                $item.Tag = [string]$s.Name
                $item.SubItems[2].Tag = [bool]$s.Archived
                $item.SubItems[5].Tag = [bool]$s.IsLive
                [void]$sessionList.Items.Add($item)

                if ($selectedTag -and [string]$item.Tag -eq $selectedTag) {
                    $item.Selected = $true
                    $item.Focused = $true
                    $item.EnsureVisible()
                }
            }
        } finally {
            $sessionList.EndUpdate()
        }

        $script:lastGuiSessionSignature = $signature
        Update-GuiSelectionState
    } finally {
        $script:guiRefreshInProgress = $false
    }
}

$createButton.Add_Click({
    try {
        $selectedType = [string]$typeCombo.SelectedItem
        $sessionTitle = [string]$nameBox.Text
        $selectedDirectory = [string]$directoryCombo.Text
        New-GuiProfileSession -ProfileName $selectedType -SessionTitle $sessionTitle -WindowsWorkingDirectory $selectedDirectory -TargetDistro $Distro
        Refresh-GuiDirectorySuggestions
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Launch Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$browseButton.Add_Click({
    try {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Choose the folder to open for the new agent session'
        $dialog.SelectedPath = Resolve-WindowsWorkingDirectory -PathText ([string]$directoryCombo.Text)
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $directoryCombo.Text = $dialog.SelectedPath
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Browse Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$sessionList.Add_SelectedIndexChanged({
    Update-GuiSelectionState
})

$showArchivedCheckBox.Add_CheckedChanged({
    try {
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Filter Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$refreshButton.Add_Click({
    try {
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Refresh Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$renameButton.Add_Click({
    try {
        if ($sessionList.SelectedItems.Count -eq 0) {
            return
        }

        $selected = $sessionList.SelectedItems[0]
        $currentSession = Get-SessionRecordByName -TargetSessionName ([string]$selected.Tag) -TargetDistro $Distro
        if (-not $currentSession) {
            throw "Session '$([string]$selected.Tag)' was not found."
        }

        $initialTitle = [string]$currentSession.DisplayTitle
        $newTitle = [Microsoft.VisualBasic.Interaction]::InputBox(
            'Choose a clearer title for this session.',
            'Rename Session',
            $initialTitle
        )
        if (-not $newTitle -or -not $newTitle.Trim()) {
            return
        }

        Set-ManagedSessionTitle -TargetSessionName ([string]$selected.Tag) -TargetTitle $newTitle -TargetDistro $Distro
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Rename Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$archiveButton.Add_Click({
    try {
        if ($sessionList.SelectedItems.Count -eq 0) {
            return
        }

        $selected = $sessionList.SelectedItems[0]
        $isArchived = [bool]$selected.SubItems[2].Tag
        Set-ManagedSessionArchivedState -TargetSessionName ([string]$selected.Tag) -Archived (-not $isArchived) -TargetDistro $Distro
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Archive Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$closeSessionButton.Add_Click({
    try {
        if ($sessionList.SelectedItems.Count -eq 0) {
            return
        }

        $selected = $sessionList.SelectedItems[0]
        Close-ManagedSession -TargetSessionName ([string]$selected.Tag) -TargetDistro $Distro
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Close Session Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$deleteSessionButton.Add_Click({
    try {
        if ($sessionList.SelectedItems.Count -eq 0) {
            return
        }

        $selected = $sessionList.SelectedItems[0]
        Remove-ManagedSession -TargetSessionName ([string]$selected.Tag) -TargetDistro $Distro
        Refresh-GuiSessions -Force
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Delete Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

$form.Add_Activated({
    try {
        Refresh-GuiDirectorySuggestions
        Refresh-GuiSessions
    } catch {
    }
})

$autoRefreshTimer.Add_Tick({
    try {
        Refresh-GuiSessions
    } catch {
    }
})

$resumeButton.Add_Click({
    try {
        if ($sessionList.SelectedItems.Count -eq 0) {
            [System.Windows.Forms.MessageBox]::Show(
                'Select a session first.',
                'Resume Session',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
            return
        }

        $selected = $sessionList.SelectedItems[0]
        if (-not [bool]$selected.SubItems[5].Tag) {
            [System.Windows.Forms.MessageBox]::Show(
                'This session is closed. Only running sessions can be reopened.',
                'Open Existing Session',
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            ) | Out-Null
            return
        }
        Open-GuiExistingSession -TargetSessionName ([string]$selected.Tag) -TargetDistro $Distro
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            'Open Existing Error',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})

[void]$form.Add_Shown({
    Refresh-GuiDirectorySuggestions
    Refresh-GuiSessions -Force
    $autoRefreshTimer.Start()
    if ($SmokeTest) {
        $form.Close()
    }
})

$form.Add_FormClosed({
    $autoRefreshTimer.Stop()
    $autoRefreshTimer.Dispose()
})

[void]$form.ShowDialog()
