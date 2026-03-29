$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RalphWeztermWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)]
    public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 processId);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr ProcessHandle, UInt32 DesiredAccess, out IntPtr TokenHandle);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, out int TokenInformation, int TokenInformationLength, out int ReturnLength);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);
}
"@

$wezterm = 'C:\Program Files\WezTerm\wezterm.exe'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wslTextResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_text_result.txt'
$wslImageResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_image_result.txt'
$wslTextChecker = '/tmp/ralph_check_text.py'
$wslImageChecker = '/tmp/ralph_check_image.py'
$wslStartCommand = 'wsl.exe -d Ubuntu --cd /home/devkit/.pi/agent/extensions/pi-multi-modal --exec zsh -i'
$paneId = $null

function Get-ProcessElevation([int]$ProcessId) {
  $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  $TOKEN_QUERY = 0x0008
  $TokenElevation = 20

  $processHandle = [RalphWeztermWin32]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, [uint32]$ProcessId)
  if ($processHandle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed for pid ${ProcessId}: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $tokenHandle = [IntPtr]::Zero
  if (-not [RalphWeztermWin32]::OpenProcessToken($processHandle, $TOKEN_QUERY, [ref]$tokenHandle)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [RalphWeztermWin32]::CloseHandle($processHandle) | Out-Null
    throw "OpenProcessToken failed for pid ${ProcessId}: $errorCode"
  }

  try {
    $elevation = 0
    $returnLength = 0
    if (-not [RalphWeztermWin32]::GetTokenInformation($tokenHandle, $TokenElevation, [ref]$elevation, 4, [ref]$returnLength)) {
      throw "GetTokenInformation failed for pid ${ProcessId}: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return [bool]$elevation
  }
  finally {
    [RalphWeztermWin32]::CloseHandle($tokenHandle) | Out-Null
    [RalphWeztermWin32]::CloseHandle($processHandle) | Out-Null
  }
}

function Get-VisibleWezTermWindows {
  $rows = New-Object System.Collections.Generic.List[object]
  $foreground = [RalphWeztermWin32]::GetForegroundWindow().ToInt64()

  $null = [RalphWeztermWin32]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [RalphWeztermWin32]::IsWindowVisible($hWnd)) { return $true }

    $procId = 0
    [void][RalphWeztermWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    if ($procId -eq 0) { return $true }

    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'wezterm-gui') { return $true }

    $length = [RalphWeztermWin32]::GetWindowTextLength($hWnd)
    $text = New-Object System.Text.StringBuilder ($length + 1)
    [void][RalphWeztermWin32]::GetWindowText($hWnd, $text, $text.Capacity)

    $rows.Add([pscustomobject]@{
      handle = $hWnd.ToInt64()
      pid = $procId
      title = $text.ToString()
      elevated = Get-ProcessElevation -ProcessId $procId
      isForeground = ($hWnd.ToInt64() -eq $foreground)
    }) | Out-Null
    return $true
  }, [IntPtr]::Zero)

  return @($rows.ToArray())
}

function Get-CurrentProcessElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Path"
}

function New-KeyInput([UInt16]$vk, [bool]$keyUp = $false) {
  $KEYEVENTF_KEYUP = 0x0002
  $input = New-Object RalphWeztermWin32+INPUT
  $input.type = 1
  $input.U.ki.wVk = $vk
  $input.U.ki.dwFlags = if ($keyUp) { $KEYEVENTF_KEYUP } else { 0 }
  return $input
}

function Focus-WezTermWindow([UInt64]$WindowHandle) {
  $VK_MENU = 0x12
  $KEYEVENTF_KEYUP = 0x0002
  $handle = [IntPtr]::new([Int64]$WindowHandle)
  [RalphWeztermWin32]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [RalphWeztermWin32]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [RalphWeztermWin32]::ShowWindowAsync($handle, 5) | Out-Null
  if (-not [RalphWeztermWin32]::SetForegroundWindow($handle)) {
    throw "Failed to focus WezTerm window $WindowHandle"
  }
  Start-Sleep -Milliseconds 400
}

function Send-CtrlShiftVAndEnter {
  $inputs = @(
    (New-KeyInput 0x11),
    (New-KeyInput 0x10),
    (New-KeyInput 0x56),
    (New-KeyInput 0x56 $true),
    (New-KeyInput 0x10 $true),
    (New-KeyInput 0x11 $true)
  )
  [void][RalphWeztermWin32]::SendInput([uint32]$inputs.Count, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][RalphWeztermWin32+INPUT]))
  Start-Sleep -Milliseconds 300
  $enter = @((New-KeyInput 0x0D), (New-KeyInput 0x0D $true))
  [void][RalphWeztermWin32]::SendInput([uint32]$enter.Count, $enter, [Runtime.InteropServices.Marshal]::SizeOf([type][RalphWeztermWin32+INPUT]))
  Start-Sleep -Milliseconds 500
}

function Invoke-WezTermCli([string[]]$Args) {
  & $wezterm @Args
}

$visibleWezTermWindows = Get-VisibleWezTermWindows
if ($visibleWezTermWindows.Count -eq 0) {
  throw 'No visible WezTerm GUI window found. Open the real Windows WezTerm window first.'
}

$targetWindow = $visibleWezTermWindows | Where-Object isForeground | Select-Object -First 1
if (-not $targetWindow) {
  $targetWindow = $visibleWezTermWindows | Select-Object -First 1
}

$currentProcessElevated = Get-CurrentProcessElevated
if ($targetWindow.elevated -and -not $currentProcessElevated) {
  throw (
    "Refusing to fake proof: the visible real WezTerm window pid=$($targetWindow.pid) is elevated, but this verifier is not elevated. " +
    'Windows UIPI blocks non-elevated key injection into elevated GUI windows, so Ctrl+Shift+V cannot be verified from this session. ' +
    'Re-run this verifier from an elevated Windows PowerShell process on the same desktop as the target WezTerm window.'
  )
}

Remove-Item $wslTextResult, $wslImageResult -ErrorAction SilentlyContinue

try {
  $paneId = (Invoke-WezTermCli @('cli', 'spawn', '--window-id', '0', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/devkit/.pi/agent/extensions/pi-multi-modal', '--exec', 'zsh', '-i')).Trim()
  if (-not $paneId) {
    throw 'Failed to create temporary direct-shell pane in the real WezTerm window.'
  }

  Start-Sleep -Seconds 3
  Invoke-WezTermCli @('cli', 'activate-pane', '--pane-id', $paneId) | Out-Null
  Start-Sleep -Milliseconds 500

  Focus-WezTermWindow -WindowHandle ([UInt64]$targetWindow.handle)

  Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', [string][char]3) | Out-Null
  Start-Sleep -Seconds 1
  Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', "python3 $wslTextChecker ") | Out-Null
  Set-Clipboard -Value 'direct-shell-text-proof'
  Start-Sleep -Milliseconds 300
  Send-CtrlShiftVAndEnter
  Wait-ForFile -Path $wslTextResult

  Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', [string][char]3) | Out-Null
  Start-Sleep -Seconds 1
  Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', "python3 $wslImageChecker ") | Out-Null

  $bitmap = New-Object System.Drawing.Bitmap 2,2
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 0, 128, 255))
  $graphics.Dispose()
  [System.Windows.Forms.Clipboard]::SetImage($bitmap)
  $bitmap.Dispose()
  Start-Sleep -Milliseconds 300
  Send-CtrlShiftVAndEnter
  Wait-ForFile -Path $wslImageResult

  [pscustomobject]@{
    targetWindow = $targetWindow
    currentProcessElevated = $currentProcessElevated
    text = Get-Content $wslTextResult -Raw
    image = Get-Content $wslImageResult -Raw
  } | ConvertTo-Json -Compress
}
finally {
  if ($paneId) {
    try {
      Invoke-WezTermCli @('cli', 'kill-pane', '--pane-id', $paneId) | Out-Null
    }
    catch {
    }
  }
}
