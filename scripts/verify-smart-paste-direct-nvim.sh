#!/usr/bin/env bash
set -euo pipefail

WEZTERM_EXE=${WEZTERM_EXE:-'/mnt/c/Program Files/WezTerm/wezterm.exe'}
POWERSHELL_EXE=${POWERSHELL_EXE:-'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'}
REPO_ROOT=/home/devkit/.pi/agent/extensions/pi-multi-modal
TEXT_RESULT=/tmp/ralph_direct_nvim_text_result.txt
IMAGE_RESULT=/tmp/ralph_direct_nvim_image_result.txt
CURRENT_PANE_ID=

log() {
  printf '[verify:direct-nvim] %s\n' "$1"
}

cleanup() {
  if [[ -n ${CURRENT_PANE_ID:-} ]]; then
    "$WEZTERM_EXE" cli kill-pane --pane-id "$CURRENT_PANE_ID" >/dev/null 2>&1 || true
    CURRENT_PANE_ID=
  fi
}
trap cleanup EXIT

get_parent_pane_id() {
  python3 - <<'PY'
import json
import subprocess

wezterm = '/mnt/c/Program Files/WezTerm/wezterm.exe'
output = subprocess.check_output([wezterm, 'cli', 'list', '--format', 'json'], text=True)
panes = json.loads(output)
if not panes:
    raise SystemExit('No WezTerm panes available for verification')
active = next((pane for pane in panes if pane.get('is_active')), panes[0])
print(active['pane_id'])
PY
}

spawn_verification_pane() {
  local parent_pane
  parent_pane=$(get_parent_pane_id)
  CURRENT_PANE_ID=$("$WEZTERM_EXE" cli spawn --pane-id "$parent_pane" --new-window -- \
    wsl.exe -d Ubuntu --cd "$REPO_ROOT" --exec zsh -i | tr -d '\r\n')
  log "spawned pane ${CURRENT_PANE_ID}"
  sleep 2
}

send_text() {
  "$WEZTERM_EXE" cli send-text --pane-id "$CURRENT_PANE_ID" --no-paste "$1"
}

wait_for_file() {
  local path=$1
  for _ in $(seq 1 80); do
    [[ -f "$path" ]] && return 0
    sleep 0.25
  done
  echo "Timed out waiting for $path" >&2
  return 1
}

seed_text_clipboard() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Set-Clipboard -Value "direct-nvim-text-proof"'
}

seed_image_clipboard() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap 2,2; $bmp.SetPixel(0,0,[System.Drawing.Color]::Red); $bmp.SetPixel(1,0,[System.Drawing.Color]::Green); $bmp.SetPixel(0,1,[System.Drawing.Color]::Blue); $bmp.SetPixel(1,1,[System.Drawing.Color]::White); [System.Windows.Forms.Clipboard]::SetImage($bmp); $bmp.Dispose()'
}

open_nvim_and_trigger_paste() {
  local target=$1
  rm -f "$target"
  send_text "nvim ${target}"$'\r'
  sleep 2
  send_text $'i'
  sleep 0.5
  send_text $'\e[24~'
  sleep 1.5
  send_text $'\e:w!\r'
  wait_for_file "$target"
}

verify_text_case() {
  seed_text_clipboard
  spawn_verification_pane
  open_nvim_and_trigger_paste "$TEXT_RESULT"

  local actual
  actual=$(tr -d '\r\n' < "$TEXT_RESULT")
  if [[ "$actual" != 'direct-nvim-text-proof' ]]; then
    echo "Unexpected text result: $actual" >&2
    return 1
  fi

  log "text proof: $actual"
  send_text $'\e:q!\r'
  cleanup
}

verify_image_case() {
  seed_image_clipboard
  spawn_verification_pane
  open_nvim_and_trigger_paste "$IMAGE_RESULT"

  local inserted image_path
  inserted=$(tr -d '\r\n' < "$IMAGE_RESULT")
  if [[ ! "$inserted" =~ ^@/ ]]; then
    echo "Unexpected image result: $inserted" >&2
    return 1
  fi

  image_path=${inserted#@}
  if [[ ! -f "$image_path" ]]; then
    echo "Inserted image path is missing: $image_path" >&2
    return 1
  fi

  python3 - <<'PY' "$image_path"
from PIL import Image
import sys
path = sys.argv[1]
image = Image.open(path)
print(f"[verify:direct-nvim] image proof: {path} size={image.size} mode={image.mode}")
PY

  send_text $'\e:q!\r'
  cleanup
}

verify_text_case
verify_image_case
log 'direct Neovim smart paste verified'
