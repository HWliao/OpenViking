Option Explicit

Dim shell, fso, args
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

Dim appDir, configPath, logPath, serverLogPath, logDir, backupCount
If args.Count >= 1 Then
    appDir = args.Item(0)
Else
    appDir = fso.GetParentFolderName(WScript.ScriptFullName)
End If

If args.Count >= 2 Then
    configPath = args.Item(1)
Else
    configPath = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.openviking\ov.conf"
End If

logDir = fso.BuildPath(appDir, "logs")
If args.Count >= 3 Then
    logPath = args.Item(2)
Else
    logPath = fso.BuildPath(logDir, "openviking-server-wrapper.log")
End If

If args.Count >= 4 Then
    serverLogPath = args.Item(3)
Else
    serverLogPath = fso.BuildPath(logDir, "openviking.log")
End If

backupCount = 5
If args.Count >= 5 Then
    On Error Resume Next
    backupCount = CLng(args.Item(4))
    If Err.Number <> 0 Then
        Err.Clear
        backupCount = 5
    End If
    On Error GoTo 0
End If

EnsureFolder fso.GetParentFolderName(logPath)
ArchiveLog logPath, backupCount
If IsRealLogPath(serverLogPath) Then
    EnsureFolder fso.GetParentFolderName(serverLogPath)
    If LCase(serverLogPath) <> LCase(logPath) Then
        ArchiveLog serverLogPath, backupCount
    End If
End If

If Not fso.FolderExists(appDir) Then
    AppendLine logPath, "ERROR install dir not found: " & appDir
    WScript.Quit 1
End If

If Not fso.FileExists(configPath) Then
    AppendLine logPath, "ERROR config file not found: " & configPath
    WScript.Quit 1
End If

shell.CurrentDirectory = appDir
shell.Environment("PROCESS")("OPENVIKING_CONFIG_FILE") = configPath
shell.Environment("PROCESS")("PYTHONIOENCODING") = "utf-8"
shell.Environment("PROCESS")("PYTHONUTF8") = "1"

AppendLine logPath, "Starting openviking-server with config: " & configPath

Dim cmd
cmd = "cmd.exe /d /c " & Quote(Quote("openviking-server") & " --config " & Quote(configPath) & " >> " & Quote(logPath) & " 2>&1")
shell.Run cmd, 0, False

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function

Sub EnsureFolder(path)
    Dim parent
    If Len(path) = 0 Then Exit Sub
    If fso.FolderExists(path) Then Exit Sub
    parent = fso.GetParentFolderName(path)
    If Len(parent) > 0 And Not fso.FolderExists(parent) Then
        EnsureFolder parent
    End If
    fso.CreateFolder path
End Sub

Sub AppendLine(path, line)
    Dim file
    On Error Resume Next
    Set file = fso.OpenTextFile(path, 8, True)
    If Err.Number = 0 Then
        file.WriteLine Now & " " & line
        file.Close
    End If
    Err.Clear
    On Error GoTo 0
End Sub

Function IsRealLogPath(path)
    Dim normalized
    normalized = LCase(Trim(path))
    IsRealLogPath = Len(normalized) > 0 And normalized <> "stdout" And normalized <> "stderr"
End Function

Sub ArchiveLog(path, backups)
    Dim i, oldPath, newPath
    If backups <= 0 Then Exit Sub
    If Not fso.FileExists(path) Then Exit Sub

    On Error Resume Next
    For i = backups To 1 Step -1
        oldPath = path & "." & i
        If fso.FileExists(oldPath) Then
            If i >= backups Then
                fso.DeleteFile oldPath, True
            Else
                newPath = path & "." & (i + 1)
                If fso.FileExists(newPath) Then fso.DeleteFile newPath, True
                fso.MoveFile oldPath, newPath
            End If
        End If
    Next

    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Sub
    End If

    fso.MoveFile path, path & ".1"
    If Err.Number <> 0 Then
        Err.Clear
    End If
    On Error GoTo 0
End Sub
