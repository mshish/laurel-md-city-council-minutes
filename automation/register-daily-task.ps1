[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PowerShellPath = 'C:\Program Files\PowerShell\7\pwsh.exe',
    [string]$CodexPath = 'C:\Users\mscis\.bun\install\global\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
$resolvedPowerShell = (Resolve-Path -LiteralPath $PowerShellPath -ErrorAction Stop).Path
$resolvedCodex = (Resolve-Path -LiteralPath $CodexPath -ErrorAction Stop).Path

$timeZone = Get-TimeZone
if ($timeZone.Id -ne 'Eastern Standard Time') {
    throw "The machine timezone is '$($timeZone.Id)'. Set Windows to Eastern Time before registering the 7:00 AM local schedule."
}

$taskName = 'LaurelCouncilMinutes-Daily'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Task '$taskName' already exists. Inspect it in Task Scheduler before changing it."
}

$runnerPath = Join-Path $PSScriptRoot 'run-daily.ps1'
$argumentList = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-File', $runnerPath,
    '-RepositoryRoot', $resolvedRoot,
    '-CodexPath', $resolvedCodex
)
$argumentString = ($argumentList | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
}) -join ' '

$action = New-ScheduledTaskAction `
    -Execute $resolvedPowerShell `
    -Argument $argumentString `
    -WorkingDirectory $resolvedRoot
$firstRun = (Get-Date).Date.AddHours(7)
if ((Get-Date) -ge $firstRun) { $firstRun = $firstRun.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $firstRun
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Runs the local Laurel council minutes workflow each day at 7:00 AM Eastern while this user is signed in.'

Register-ScheduledTask -TaskName $taskName -InputObject $task -ErrorAction Stop | Out-Null
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Output "registered=$($registered.TaskName) timezone=$($timeZone.Id) daily=07:00 first_run=$($firstRun.ToString('yyyy-MM-dd HH:mm')) multiple_instances=IgnoreNew"
