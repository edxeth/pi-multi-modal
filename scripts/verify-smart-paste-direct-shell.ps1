$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RalphWeztermWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$wezterm = 'C:\Program Files\WezTerm\wezterm.exe'
$class = 'RalphVerify'
$wslTextResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_text_result.txt'
$wslImageResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_image_result.txt'
$wslTextChecker = '/tmp/ralph_check_text.py'
$wslImageChecker = '/tmp/ralph_check_image.py'
$wslStartCommand = 'wsl.exe -d Ubuntu --cd /home/devkit/.pi/agent/extensions/pi-multi-modal --exec zsh -i'
$verifyGui = $null

function Get-WezTermGuiProcessIds {
  @(Get-Process wezterm-gui -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Get-WindowHandleForProcess([int]$ProcessId) {
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne 0) {
      return [UInt64]$proc.MainWindowHandle.ToInt64()
    }
  }

  $script:windowHandleResult = 0
  $null = [RalphWeztermWin32]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [RalphWeztermWin32]::IsWindowVisible($hWnd)) { return $true }
    $procId = 0
    [void][RalphWeztermWin32]::GetWindowThreadProcessId($hWnd, [ref]$procId)
    if ($procId -ne $ProcessId) { return $true }
    $script:windowHandleResult = $hWnd.ToInt64()
    return $false
  }, [IntPtr]::Zero)
  if ($script:windowHandleResult -eq 0) { return $null }
  return [UInt64]$script:windowHandleResult
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Path"
}

function Send-CtrlShiftV([UInt64]$WindowHandle, [switch]$PressEnter) {
  $VK_CONTROL = 0x11
  $VK_SHIFT = 0x10
  $VK_V = 0x56
  $VK_RETURN = 0x0D
  $KEYEVENTF_KEYUP = 0x0002
  $hWnd = [IntPtr]::new([Int64]$WindowHandle)
  [RalphWeztermWin32]::ShowWindowAsync($hWnd, 5) | Out-Null
  Start-Sleep -Milliseconds 200
  [RalphWeztermWin32]::SetForegroundWindow($hWnd) | Out-Null
  Start-Sleep -Milliseconds 400
  [RalphWeztermWin32]::keybd_event($VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  [RalphWeztermWin32]::keybd_event($VK_SHIFT, 0, 0, [UIntPtr]::Zero)
  [RalphWeztermWin32]::keybd_event($VK_V, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [RalphWeztermWin32]::keybd_event($VK_V, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  [RalphWeztermWin32]::keybd_event($VK_SHIFT, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  [RalphWeztermWin32]::keybd_event($VK_CONTROL, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  if ($PressEnter) {
    Start-Sleep -Milliseconds 250
    [RalphWeztermWin32]::keybd_event($VK_RETURN, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [RalphWeztermWin32]::keybd_event($VK_RETURN, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  }
}

function Invoke-WezTermCli([string[]]$Args) {
  & $wezterm @Args
}

$beforeIds = Get-WezTermGuiProcessIds
Remove-Item $wslTextResult, $wslImageResult -ErrorAction SilentlyContinue

try {
  Start-Process -FilePath $wezterm -ArgumentList @('start', '--always-new-process', '--class', $class) | Out-Null

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $verifyGui = Get-Process wezterm-gui -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -notin $beforeIds } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($verifyGui) { break }
  }
  if (-not $verifyGui) {
    throw 'Failed to start RalphVerify WezTerm GUI'
  }

  $windowHandle = $null
  for ($i = 0; $i -lt 40; $i++) {
    $windowHandle = Get-WindowHandleForProcess -ProcessId $verifyGui.Id
    if ($windowHandle) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $windowHandle) {
    throw 'Failed to find RalphVerify WezTerm window handle'
  }

  Invoke-WezTermCli @('cli', '--class', $class, 'send-text', '--pane-id', '0', '--no-paste', "$wslStartCommand`r") | Out-Null
  Start-Sleep -Seconds 4

  Invoke-WezTermCli @('cli', '--class', $class, 'send-text', '--pane-id', '0', '--no-paste', "python3 $wslTextChecker ") | Out-Null
  Set-Clipboard -Value 'direct-shell-text-proof'
  Start-Sleep -Milliseconds 300
  Send-CtrlShiftV -WindowHandle $windowHandle -PressEnter
  Wait-ForFile -Path $wslTextResult

  Invoke-WezTermCli @('cli', '--class', $class, 'send-text', '--pane-id', '0', '--no-paste', [string][char]3) | Out-Null
  Start-Sleep -Seconds 1
  Invoke-WezTermCli @('cli', '--class', $class, 'send-text', '--pane-id', '0', '--no-paste', "python3 $wslImageChecker ") | Out-Null

  $bitmap = New-Object System.Drawing.Bitmap 2,2
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 0, 128, 255))
  $graphics.Dispose()
  [System.Windows.Forms.Clipboard]::SetImage($bitmap)
  $bitmap.Dispose()
  Start-Sleep -Milliseconds 300
  Send-CtrlShiftV -WindowHandle $windowHandle -PressEnter
  Wait-ForFile -Path $wslImageResult

  [pscustomobject]@{
    text = Get-Content $wslTextResult -Raw
    image = Get-Content $wslImageResult -Raw
  } | ConvertTo-Json -Compress
}
finally {
  if ($verifyGui -and -not $verifyGui.HasExited) {
    try {
      $verifyGui.CloseMainWindow() | Out-Null
      Start-Sleep -Seconds 1
      if (-not $verifyGui.HasExited) {
        $verifyGui | Stop-Process -Force
      }
    } catch {
      if (-not $verifyGui.HasExited) {
        $verifyGui | Stop-Process -Force
      }
    }
  }
}
