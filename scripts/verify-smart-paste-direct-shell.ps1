param(
  [string]$ResultPath = '',
  [switch]$SkipAutoElevate
)

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
$currentPaneId = $env:WEZTERM_PANE
$paneId = $null

function Write-Progress([string]$message) {
  Write-Host "[verify:direct-shell] $message"
}

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
  $output = & $wezterm @Args 2>&1
  $exitCode = $LASTEXITCODE

  $text = ''
  if ($null -ne $output) {
    if ($output -is [System.Array]) {
      $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    }
    else {
      $text = $output.ToString()
    }
  }

  if ($exitCode -ne 0) {
    throw "wezterm cli failed ($exitCode): $text"
  }

  return $text
}

function Write-VerificationResult($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 6
  if ($ResultPath) {
    Set-Content -Path $ResultPath -Value $json -Encoding UTF8
    return
  }
  Write-Output $json
}

function Invoke-ElevatedVerifier([string]$ScriptPath) {
  $resultFile = Join-Path $env:TEMP ("ralph-smart-paste-" + [guid]::NewGuid().ToString() + ".json")
  try {
    $proc = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -PassThru -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $ScriptPath,
      '-SkipAutoElevate',
      '-ResultPath', $resultFile
    )

    if (-not (Test-Path $resultFile)) {
      throw 'UAC prompt was not approved or the elevated verifier did not return a result file.'
    }

    $raw = Get-Content -Path $resultFile -Raw
    if ($proc.ExitCode -ne 0) {
      try {
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.error) {
          throw [string]$parsed.error
        }
      }
      catch {
        throw "Elevated verifier failed: $raw"
      }
    }

    if ($ResultPath) {
      Set-Content -Path $ResultPath -Value $raw -Encoding UTF8
      return
    }

    Write-Output $raw
    return
  }
  finally {
    Remove-Item -Path $resultFile -ErrorAction SilentlyContinue
  }
}

function Invoke-Verification {
  if (-not $currentPaneId) {
    throw 'WEZTERM_PANE is not set. Run this verifier from inside the target elevated WezTerm pane.'
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
  Write-Progress "current pane=$currentPaneId elevated=$currentProcessElevated targetWindowPid=$($targetWindow.pid) title=$($targetWindow.title)"

  if ($targetWindow.elevated -and -not $currentProcessElevated) {
    if ($SkipAutoElevate) {
      throw (
        "Refusing to fake proof: the visible real WezTerm window pid=$($targetWindow.pid) is elevated, but this verifier is not elevated. " +
        'Windows UIPI blocks non-elevated key injection into elevated GUI windows, so Ctrl+Shift+V cannot be verified from this session. ' +
        'Re-run this verifier from an elevated Windows PowerShell process on the same desktop as the target WezTerm window.'
      )
    }

    Write-Progress 'attempting RunAs relaunch'
    Invoke-ElevatedVerifier -ScriptPath $PSCommandPath
    return $null
  }

  Remove-Item $wslTextResult, $wslImageResult -ErrorAction SilentlyContinue

  try {
    Write-Progress 'spawning temporary direct-shell tab from current pane'
    $spawnOutput = Invoke-WezTermCli @('cli', 'spawn', '--pane-id', $currentPaneId, 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/devkit/.pi/agent/extensions/pi-multi-modal', '--exec', 'zsh', '-i')
    $paneId = ''
    if ($spawnOutput) {
      $paneId = $spawnOutput.Trim()
    }
    Write-Progress "spawn output=$spawnOutput"
    if (-not $paneId) {
      throw 'Failed to create temporary direct-shell pane in the current WezTerm window.'
    }

    Start-Sleep -Seconds 3

    $paneList = Invoke-WezTermCli @('cli', 'list', '--format', 'json') | ConvertFrom-Json
    $spawnedPane = $paneList | Where-Object { $_.pane_id -eq [int]$paneId } | Select-Object -First 1
    if ($spawnedPane -and $spawnedPane.tab_id) {
      Invoke-WezTermCli @('cli', 'activate-tab', '--tab-id', [string]$spawnedPane.tab_id) | Out-Null
      Start-Sleep -Milliseconds 300
    }
    Invoke-WezTermCli @('cli', 'activate-pane', '--pane-id', $paneId) | Out-Null
    Start-Sleep -Milliseconds 500

    Focus-WezTermWindow -WindowHandle ([UInt64]$targetWindow.handle)

    Write-Progress 'running text proof'
    Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', [string][char]3) | Out-Null
    Start-Sleep -Seconds 1
    Invoke-WezTermCli @('cli', 'send-text', '--pane-id', $paneId, '--no-paste', "python3 $wslTextChecker ") | Out-Null
    Set-Clipboard -Value 'direct-shell-text-proof'
    Start-Sleep -Milliseconds 300
    Send-CtrlShiftVAndEnter
    Wait-ForFile -Path $wslTextResult

    Write-Progress 'running image proof'
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

    return [pscustomobject]@{
      targetWindow = $targetWindow
      currentProcessElevated = $currentProcessElevated
      currentPaneId = $currentPaneId
      spawnedPaneId = $paneId
      text = Get-Content $wslTextResult -Raw
      image = Get-Content $wslImageResult -Raw
    }
  }
  catch {
    $paneText = ''
    if ($paneId) {
      try {
        $paneText = Invoke-WezTermCli @('cli', 'get-text', '--pane-id', $paneId, '--start-line', '-30') | Out-String
      }
      catch {
      }
    }

    $message = $_.Exception.Message
    if ($paneText) {
      $message += "`n--- pane ---`n$paneText"
    }
    throw $message
  }
  finally {
    if ($paneId) {
      Write-Progress "cleaning up pane $paneId"
      try {
        Invoke-WezTermCli @('cli', 'kill-pane', '--pane-id', $paneId) | Out-Null
      }
      catch {
      }
    }
  }
}

try {
  $result = Invoke-Verification
  if ($null -ne $result) {
    Write-VerificationResult $result
  }
}
catch {
  if ($ResultPath) {
    Write-VerificationResult ([pscustomobject]@{ error = $_.Exception.Message })
    exit 1
  }
  throw
}
