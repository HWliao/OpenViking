param(
    [ValidateSet("create", "remove", "start", "stop", "status", "menu")]
    [string]$Action = "menu",
    [string]$InstallDir = "",
    [string]$ConfigPath = (Join-Path $env:USERPROFILE ".openviking\ov.conf"),
    [string]$CliConfigPath = (Join-Path $env:USERPROFILE ".openviking\ovcli.conf"),
    [int]$LogonDelaySeconds = 10,
    [int]$WrapperLogBackups = 5
)

$taskName = "OpenVikingServerTask"
$taskDescription = "OpenViking HTTP Server for Current User"
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstallDir))
{
    $InstallDir = $scriptDir
}
$resolvedInstallDir = (Resolve-Path -LiteralPath $InstallDir -ErrorAction SilentlyContinue).Path
if (-not $resolvedInstallDir)
{
    $resolvedInstallDir = $InstallDir
}
$appDir = $resolvedInstallDir
$launcherPath = Join-Path $scriptDir "start-openviking-server.vbs"
$configPath = $ConfigPath
$cliConfigPath = $CliConfigPath
$dataDir = Join-Path $appDir "data"
$logDir = Join-Path $appDir "logs"
$wrapperLogPath = Join-Path $logDir "openviking-server-wrapper.log"

function Test-IsAdministrator
{
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
}

function Ensure-Administrator
{
    if (Test-IsAdministrator)
    {
        return
    }

    Write-Host "Requesting administrator privileges" -ForegroundColor Yellow
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"",
        "-Action", $Action,
        "-InstallDir", "`"$appDir`"",
        "-ConfigPath", "`"$configPath`"",
        "-CliConfigPath", "`"$cliConfigPath`"",
        "-LogonDelaySeconds", $LogonDelaySeconds,
        "-WrapperLogBackups", $WrapperLogBackups
    )
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments
    exit
}

function Ensure-Directory
{
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container))
    {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-ConfiguredServerLogPath
{
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf))
    {
        return Join-Path $logDir "openviking.log"
    }

    try
    {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $output = $config.log.output
        if ([string]::IsNullOrWhiteSpace($output))
        {
            return Join-Path $logDir "openviking.log"
        }
        if ($output -eq "file")
        {
            return Join-Path (Join-Path $config.storage.workspace "log") "openviking.log"
        }
        if ($output -in @("stdout", "stderr"))
        {
            return $output
        }
        return [Environment]::ExpandEnvironmentVariables($output)
    }
    catch
    {
        return Join-Path $logDir "openviking.log"
    }
}

function Format-FileSize
{
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf))
    {
        return "missing"
    }
    $size = (Get-Item -LiteralPath $Path).Length
    if ($size -ge 1GB) { return "{0:N2} GB" -f ($size / 1GB) }
    if ($size -ge 1MB) { return "{0:N2} MB" -f ($size / 1MB) }
    if ($size -ge 1KB) { return "{0:N2} KB" -f ($size / 1KB) }
    return "$size B"
}

function Test-AppFiles
{
    if (-not (Test-Path -LiteralPath $appDir -PathType Container))
    {
        Write-Host "ERROR Install dir not found at $appDir" -ForegroundColor Red
        return $false
    }

    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf))
    {
        Write-Host "ERROR Launcher not found at $launcherPath" -ForegroundColor Red
        return $false
    }

    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf))
    {
        Write-Host "ERROR Server config not found at $configPath" -ForegroundColor Red
        return $false
    }

    if (-not (Test-Path -LiteralPath $cliConfigPath -PathType Leaf))
    {
        Write-Host "ERROR CLI config not found at $cliConfigPath" -ForegroundColor Red
        return $false
    }

    $serverCommand = Get-Command openviking-server -ErrorAction SilentlyContinue
    if (-not $serverCommand)
    {
        Write-Host "ERROR openviking-server not found in PATH" -ForegroundColor Red
        return $false
    }

    Ensure-Directory $logDir
    return $true
}

function Show-Menu
{
    Clear-Host
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "OpenViking Server Task Scheduler Manager" -ForegroundColor White -BackgroundColor DarkBlue
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Task Name $taskName" -ForegroundColor Gray
    Write-Host "Install Dir $appDir" -ForegroundColor Gray
    Write-Host "Launcher $launcherPath" -ForegroundColor Gray
    Write-Host "Server Config $configPath" -ForegroundColor Gray
    Write-Host "CLI Config $cliConfigPath" -ForegroundColor Gray
    Write-Host "Data Dir $dataDir" -ForegroundColor Gray
    Write-Host "Log Dir $logDir" -ForegroundColor Gray
    Write-Host "Server Log $(Get-ConfiguredServerLogPath)" -ForegroundColor Gray
    Write-Host "Wrapper Log $wrapperLogPath" -ForegroundColor Gray
    Write-Host "Runs as Current User" -ForegroundColor Gray
    Write-Host ""
    Write-Host "1 Create Task at Logon" -ForegroundColor Green
    Write-Host "2 Delete Task" -ForegroundColor Red
    Write-Host "3 Run Now" -ForegroundColor Magenta
    Write-Host "4 Stop Server" -ForegroundColor DarkRed
    Write-Host "5 Check Status" -ForegroundColor Cyan
    Write-Host "0 Exit" -ForegroundColor Gray
    Write-Host ""
}

function Get-OpenVikingProcesses
{
    $escapedConfigPath = [Regex]::Escape($configPath)
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            ($_.CommandLine -match "openviking-server") -and
            ($_.CommandLine -match $escapedConfigPath)
        }
}

function Get-ServerHealth
{
    try
    {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:1933/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return "HTTP $($response.StatusCode)"
    }
    catch
    {
        return "Unavailable"
    }
}

function Get-AppStatus
{
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $procs = @(Get-OpenVikingProcesses)
    $serverLogPath = Get-ConfiguredServerLogPath

    Write-Host "Status Report" -ForegroundColor Cyan

    if ($task)
    {
        Write-Host "Scheduled Task Created" -ForegroundColor Green
        Write-Host "State $($task.State)" -ForegroundColor Gray
        Write-Host "User $($task.Principal.UserId)" -ForegroundColor Gray

        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        if ($taskInfo)
        {
            Write-Host "Next Run $($taskInfo.NextRunTime)" -ForegroundColor Gray
            Write-Host "Last Run $($taskInfo.LastRunTime)" -ForegroundColor Gray
            Write-Host "Last Result $($taskInfo.LastTaskResult)" -ForegroundColor Gray
        }
    }
    else
    {
        Write-Host "Scheduled Task Not created" -ForegroundColor Red
    }

    if ($procs.Count -gt 0)
    {
        Write-Host "Process Running PID $($procs.ProcessId -join ', ')" -ForegroundColor Green
    }
    else
    {
        Write-Host "Process Not running" -ForegroundColor Red
    }

    Write-Host "Health $(Get-ServerHealth)" -ForegroundColor Gray
    Write-Host "Server Config $configPath" -ForegroundColor Gray
    Write-Host "CLI Config $cliConfigPath" -ForegroundColor Gray
    Write-Host "Server Log $serverLogPath ($(Format-FileSize $serverLogPath))" -ForegroundColor Gray
    Write-Host "Wrapper Log $wrapperLogPath ($(Format-FileSize $wrapperLogPath))" -ForegroundColor Gray
}

function New-AppTask
{
    Ensure-Administrator

    if (-not (Test-AppFiles))
    {
        exit 1
    }

    Write-Host "Creating Hidden Scheduled Task for Current User" -ForegroundColor Cyan

    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing)
    {
        Write-Host "Existing task found removing" -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    $trigger = New-ScheduledTaskTrigger -AtLogOn
    if ($LogonDelaySeconds -gt 0)
    {
        $trigger.Delay = "PT${LogonDelaySeconds}S"
    }
    Write-Host "Trigger At user logon delayed $LogonDelaySeconds seconds" -ForegroundColor Green

    $serverLogPath = Get-ConfiguredServerLogPath
    $launcherArgs = @(
        "`"$launcherPath`"",
        "`"$appDir`"",
        "`"$configPath`"",
        "`"$wrapperLogPath`"",
        "`"$serverLogPath`"",
        $WrapperLogBackups
    ) -join " "
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument $launcherArgs -WorkingDirectory $appDir
    Write-Host "Action Hidden launcher execution" -ForegroundColor Green

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    Write-Host "Principal Current user $currentUser" -ForegroundColor Green

    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
    Write-Host "Settings Hidden task runs as current user" -ForegroundColor Green

    try
    {
        Register-ScheduledTask -TaskName $taskName -Description $taskDescription -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

        Write-Host "Task created successfully" -ForegroundColor Green
        Write-Host "Task Name $taskName" -ForegroundColor Cyan
        Write-Host "Launcher $launcherPath" -ForegroundColor Cyan
        Write-Host "Install Dir $appDir" -ForegroundColor Cyan
        Write-Host "Config $configPath" -ForegroundColor Cyan
        Write-Host "User $currentUser" -ForegroundColor Cyan
    }
    catch
    {
        Write-Host "Creation failed $_" -ForegroundColor Red
        exit 1
    }

    Get-AppStatus
}

function Remove-AppTask
{
    Ensure-Administrator

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task)
    {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Task deleted" -ForegroundColor Green
    }
    else
    {
        Write-Host "Task not found" -ForegroundColor Yellow
    }
}

function Start-TaskNow
{
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task)
    {
        Start-ScheduledTask -TaskName $taskName
        Write-Host "Task triggered" -ForegroundColor Green
        Start-Sleep -Seconds 3
        Get-AppStatus
    }
    else
    {
        Write-Host "Task not found create it first" -ForegroundColor Red
    }
}

function Stop-Program
{
    $procs = @(Get-OpenVikingProcesses)
    if ($procs.Count -gt 0)
    {
        foreach ($proc in $procs)
        {
            Stop-Process -Id $proc.ProcessId -Force
        }
        Write-Host "Server stopped" -ForegroundColor Green
    }
    else
    {
        Write-Host "Server not running" -ForegroundColor Yellow
    }
}

if ($Action -ne "menu")
{
    switch ($Action)
    {
        "create" { New-AppTask }
        "remove" { Remove-AppTask }
        "start" { Start-TaskNow }
        "stop" { Stop-Program }
        "status" { Get-AppStatus }
    }
}
else
{
    do
    {
        Show-Menu
        $choice = Read-Host "Enter choice 0 to 5"

        switch ($choice)
        {
            "1" { New-AppTask; Read-Host "Press Enter to continue" }
            "2" { Remove-AppTask; Read-Host "Press Enter to continue" }
            "3" { Start-TaskNow; Read-Host "Press Enter to continue" }
            "4" { Stop-Program; Read-Host "Press Enter to continue" }
            "5" { Get-AppStatus; Read-Host "Press Enter to continue" }
            "0" { Write-Host "Goodbye" -ForegroundColor Green }
            default { Write-Host "Invalid option" -ForegroundColor Red; Read-Host "Press Enter to continue" }
        }
    } while ($choice -ne "0")
}
