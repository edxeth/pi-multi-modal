param(
  [string]$ResultPath = '',
  [string]$WezTermClass = 'RalphVerify'
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
$wslStartCommand = 'wsl.exe -d Ubuntu --cd /home/devkit/.pi/agent/extensions/pi-multi-modal --exec zsh -i'
$smartPasteLog = Join-Path $env:USERPROFILE 'smart-paste.log'
$wslTextResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_text_result.txt'
$wslImageResult = '\\wsl.localhost\Ubuntu\tmp\ralph_direct_shell_image_result.txt'
$textProofValue = 'direct-shell-text-proof'

function Write-Progress([string]$message) {
  Write-Host "[verify:direct-shell] $message"
}

function Invoke-WezTermCli([string[]]$Args) {
  $fullArgs = @('cli', '--no-auto-start', '--class', $WezTermClass) + $Args
  $output = & $wezterm @fullArgs 2>&1
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
  $json = $value | ConvertTo-Json -Compress -Depth 8
  if ($ResultPath) {
    Set-Content -Path $ResultPath -Value $json -Encoding UTF8
    return
  }
  Write-Output $json
}

function Get-ProcessElevation([int]$ProcessId) {
  $PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
  $TOKEN_QUERY = 0x0008
  $TokenElevation = 20

  $processHandle = [RalphWeztermWin32]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, [uint32]$ProcessId)
  if ($processHandle -eq [IntPtr]::Zero) {
    return $false
  }

  $tokenHandle = [IntPtr]::Zero
  if (-not [RalphWeztermWin32]::OpenProcessToken($processHandle, $TOKEN_QUERY, [ref]$tokenHandle)) {
    [RalphWeztermWin32]::CloseHandle($processHandle) | Out-Null
    return $false
  }

  try {
    $elevation = 0
    $returnLength = 0
    if (-not [RalphWeztermWin32]::GetTokenInformation($tokenHandle, $TokenElevation, [ref]$elevation, 4, [ref]$returnLength)) {
      return $false
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
    }) | Out-Null
    return $true
  }, [IntPtr]::Zero)

  return @($rows.ToArray())
}

function Get-ForegroundWindowInfo {
  $handle = [RalphWeztermWin32]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) {
    return [pscustomobject]@{ handle = 0; pid = 0; title = ''; elevated = $false }
  }

  $procId = 0
  [void][RalphWeztermWin32]::GetWindowThreadProcessId($handle, [ref]$procId)
  $length = [RalphWeztermWin32]::GetWindowTextLength($handle)
  $text = New-Object System.Text.StringBuilder ($length + 1)
  [void][RalphWeztermWin32]::GetWindowText($handle, $text, $text.Capacity)

  return [pscustomobject]@{
    handle = $handle.ToInt64()
    pid = $procId
    title = $text.ToString()
    elevated = if ($procId -gt 0) { Get-ProcessElevation -ProcessId $procId } else { $false }
  }
}

function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 15) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Path"
}

function Wait-ForPane([int]$TimeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $paneList = Invoke-WezTermCli @('list', '--format', 'json') | ConvertFrom-Json
      if ($paneList.Count -gt 0) {
        return $paneList[0]
      }
    }
    catch {
    }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for WezTerm class '$WezTermClass' to expose a pane."
}

function New-KeyInput([UInt16]$vk, [bool]$keyUp = $false) {
  $KEYEVENTF_KEYUP = 0x0002
  $input = New-Object RalphWeztermWin32+INPUT
  $input.type = 1
  $input.U.ki.wVk = $vk
  $input.U.ki.dwFlags = if ($keyUp) { $KEYEVENTF_KEYUP } else { 0 }
  return $input
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

function Focus-WezTermWindow([UInt64]$WindowHandle) {
  $VK_MENU = 0x12
  $KEYEVENTF_KEYUP = 0x0002
  $handle = [IntPtr]::new([Int64]$WindowHandle)
  [RalphWeztermWin32]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [RalphWeztermWin32]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [RalphWeztermWin32]::ShowWindowAsync($handle, 5) | Out-Null
  $setForeground = [RalphWeztermWin32]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 400
  $foreground = Get-ForegroundWindowInfo
  return [pscustomobject]@{
    requestedHandle = $WindowHandle
    setForeground = $setForeground
    foreground = $foreground
    focused = ($foreground.handle -eq [Int64]$WindowHandle)
  }
}

function Start-VerificationWindow {
  $beforeHandles = @(Get-VisibleWezTermWindows | ForEach-Object { $_.handle })

  Write-Progress "launching verification window class=$WezTermClass"
  $proc = Start-Process -FilePath $wezterm -PassThru -ArgumentList @(
    'start',
    '--always-new-process',
    '--class', $WezTermClass,
    '--',
    'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/devkit/.pi/agent/extensions/pi-multi-modal', '--exec', 'zsh', '-i'
  )

  try {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      $current = Get-VisibleWezTermWindows | Where-Object { -not $_.elevated -and $_.handle -notin $beforeHandles }
      if ($current.Count -gt 0) {
        $window = $current | Sort-Object pid -Descending | Select-Object -First 1
        try {
          $pane = Wait-ForPane
          return [pscustomobject]@{
            processId = $proc.Id
            window = $window
            pane = $pane
          }
        }
        catch {
          throw (
            "Spawned verification window handle=$($window.handle) pid=$($window.pid) title=$($window.title), " +
            "but wezterm cli could not attach with class '$WezTermClass'."
          )
        }
      }
      Start-Sleep -Milliseconds 500
    }

    throw "Timed out waiting for verification window class '$WezTermClass'."
  }
  catch {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Stop-VerificationWindow([int]$PaneId, [int]$ProcessId) {
  Write-Progress 'cleaning up verification window'
  try {
    Invoke-WezTermCli @('send-text', '--pane-id', $PaneId, '--no-paste', "exit`r") | Out-Null
    Start-Sleep -Seconds 1
  }
  catch {
  }

  try {
    Invoke-WezTermCli @('kill-pane', '--pane-id', $PaneId) | Out-Null
  }
  catch {
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
  catch {
  }
}

function Invoke-TextProof([int]$PaneId, [UInt64]$WindowHandle) {
  Remove-Item $wslTextResult -ErrorAction SilentlyContinue
  Invoke-WezTermCli @('send-text', '--pane-id', $PaneId, '--no-paste', [string][char]3) | Out-Null
  Start-Sleep -Seconds 1
  Invoke-WezTermCli @('send-text', '--pane-id', $PaneId, '--no-paste', 'python3 -c ''import sys, pathlib; pathlib.Path("/tmp/ralph_direct_shell_text_result.txt").write_text(sys.argv[1])'' ') | Out-Null

  Set-Clipboard -Value $textProofValue
  Start-Sleep -Milliseconds 300

  $focus = Focus-WezTermWindow -WindowHandle $WindowHandle
  if (-not $focus.focused) {
    throw (
      "Unable to focus verification window handle=$WindowHandle before Ctrl+Shift+V. " +
      "setForeground=$($focus.setForeground) foregroundHandle=$($focus.foreground.handle) foregroundTitle=$($focus.foreground.title) foregroundElevated=$($focus.foreground.elevated)."
    )
  }

  Send-CtrlShiftVAndEnter
  Wait-ForFile -Path $wslTextResult
  return (Get-Content $wslTextResult -Raw)
}

function Invoke-ImageProof([int]$PaneId, [UInt64]$WindowHandle) {
  Remove-Item $wslImageResult -ErrorAction SilentlyContinue
  Invoke-WezTermCli @('send-text', '--pane-id', $PaneId, '--no-paste', [string][char]3) | Out-Null
  Start-Sleep -Seconds 1
  Invoke-WezTermCli @('send-text', '--pane-id', $PaneId, '--no-paste', 'python3 -c ''import sys, pathlib; p = pathlib.Path(sys.argv[1]); pathlib.Path("/tmp/ralph_direct_shell_image_result.txt").write_text(str(p.resolve()) if p.exists() else "MISSING:" + sys.argv[1])'' ') | Out-Null

  $bitmap = New-Object System.Drawing.Bitmap 2,2
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 0, 128, 255))
  $graphics.Dispose()
  [System.Windows.Forms.Clipboard]::SetImage($bitmap)
  $bitmap.Dispose()
  Start-Sleep -Milliseconds 300

  $focus = Focus-WezTermWindow -WindowHandle $WindowHandle
  if (-not $focus.focused) {
    throw (
      "Unable to focus verification window handle=$WindowHandle before image Ctrl+Shift+V. " +
      "setForeground=$($focus.setForeground) foregroundHandle=$($focus.foreground.handle) foregroundTitle=$($focus.foreground.title) foregroundElevated=$($focus.foreground.elevated)."
    )
  }

  Send-CtrlShiftVAndEnter
  Wait-ForFile -Path $wslImageResult
  return (Get-Content $wslImageResult -Raw)
}

function Read-SmartPasteLogTail([DateTime]$StartTime) {
  if (-not (Test-Path $smartPasteLog)) {
    return @()
  }

  return @(
    Get-Content -Path $smartPasteLog -Tail 40 |
      Where-Object {
        ($_ -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} ') -and
        ([datetime]::ParseExact($_.Substring(0, 19), 'yyyy-MM-dd HH:mm:ss', $null) -ge $StartTime)
      }
  )
}

function Invoke-Verification {
  $startTime = Get-Date
  $visibleBefore = Get-VisibleWezTermWindows
  $verification = Start-VerificationWindow

  Write-Progress "verification pid=$($verification.processId) pane=$($verification.pane.pane_id) handle=$($verification.window.handle) title=$($verification.window.title)"

  try {
    $text = Invoke-TextProof -PaneId $verification.pane.pane_id -WindowHandle ([UInt64]$verification.window.handle)
    $image = Invoke-ImageProof -PaneId $verification.pane.pane_id -WindowHandle ([UInt64]$verification.window.handle)

    return [pscustomobject]@{
      currentProcessElevated = Get-ProcessElevation -ProcessId $PID
      targetWindow = $verification.window
      pane = $verification.pane
      text = $text
      image = $image
      smartPasteLogTail = Read-SmartPasteLogTail -StartTime $startTime
      visibleWindowsBefore = $visibleBefore
      visibleWindowsAfter = Get-VisibleWezTermWindows
    }
  }
  finally {
    Stop-VerificationWindow -PaneId $verification.pane.pane_id -ProcessId $verification.processId
  }
}

try {
  $result = Invoke-Verification
  Write-VerificationResult $result
}
catch {
  Write-VerificationResult ([pscustomobject]@{
    error = $_.Exception.Message
    foreground = Get-ForegroundWindowInfo
    visibleWindows = Get-VisibleWezTermWindows
  })
  exit 1
}
