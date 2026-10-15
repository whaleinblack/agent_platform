Option Explicit
Dim shell, files, folder, executable, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
executable = "node.exe"
If WScript.Arguments.Count > 0 Then executable = WScript.Arguments(0)
shell.Environment("PROCESS")("AGENT_COORD_PORT") = "8793"
command = """" & executable & """ """ & folder & "\server.mjs"""
If WScript.Arguments.Count > 1 Then
  If WScript.Arguments(1) = "--open" Then command = command & " --open"
End If
shell.Run command, 0, False
