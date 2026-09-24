# Bring the File Explorer window whose title contains -Title to the foreground.
#
# Why this exists: explorer.exe /select opens the window, but a background
# process is not allowed to steal the foreground, so the window shows up
# BEHIND the browser and the click looks like a no-op. Attaching to the
# current foreground thread lifts that restriction for the moment.
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 scripts as
# ANSI, which would mangle anything non-ASCII written here. The (possibly
# Chinese) folder title is passed as a command-line argument, which is UTF-16
# all the way through.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File focus-helper.ps1 -Title "folder" [-TimeoutSeconds 6]
# Prints "focused:<pid>:<title>" on success, "notfound:<title>" and exit 1 otherwise.

param(
  [Parameter(Mandatory = $true)][string]$Title,
  [int]$TimeoutSeconds = 6
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Namespace KbFocus -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
'@

# explorer.exe /select creates the window asynchronously, so wait for it.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$match = $null
while ((Get-Date) -lt $deadline) {
  $match = Get-Process -Name explorer |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
  if ($null -ne $match) { break }
  Start-Sleep -Milliseconds 250
}

if ($null -eq $match) {
  Write-Output "notfound:$Title"
  exit 1
}

$hwnd = $match.MainWindowHandle
if ([KbFocus.Native]::IsIconic($hwnd)) { [void][KbFocus.Native]::ShowWindow($hwnd, 9) }

$foreground = [KbFocus.Native]::GetForegroundWindow()
[uint32]$foregroundPid = 0
$foregroundThread = [KbFocus.Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
$currentThread = [KbFocus.Native]::GetCurrentThreadId()
[void][KbFocus.Native]::AttachThreadInput($currentThread, $foregroundThread, $true)
[void][KbFocus.Native]::BringWindowToTop($hwnd)
[void][KbFocus.Native]::SetForegroundWindow($hwnd)
[KbFocus.Native]::SwitchToThisWindow($hwnd, $true)
[void][KbFocus.Native]::AttachThreadInput($currentThread, $foregroundThread, $false)

Write-Output ("focused:" + $match.Id + ":" + $match.MainWindowTitle)
