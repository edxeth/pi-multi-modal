#!/usr/bin/env bash
set -euo pipefail

WEZTERM_EXE=${WEZTERM_EXE:-'/mnt/c/Program Files/WezTerm/wezterm.exe'}
POWERSHELL_EXE=${POWERSHELL_EXE:-'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'}
REPO_ROOT=/home/devkit/.pi/agent/extensions/pi-multi-modal
TEXT_RESULT=/tmp/ralph_tmux_shell_text_result.txt
IMAGE_RESULT=/tmp/ralph_tmux_shell_image_result.txt
ENV_RESULT=/tmp/ralph_tmux_shell_env.txt
TMUX_SOCKET="ralph-smart-paste-shell-$$"
TMUX_SESSION=verify
CURRENT_PANE_ID=

log() {
  printf '[verify:tmux-shell] %s\n' "$1"
}

cleanup() {
  if [[ -n ${CURRENT_PANE_ID:-} ]]; then
    "$WEZTERM_EXE" cli kill-pane --pane-id "$CURRENT_PANE_ID" >/dev/null 2>&1 || true
    CURRENT_PANE_ID=
  fi
  tmux -L "$TMUX_SOCKET" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT

spawn_verification_pane() {
  CURRENT_PANE_ID=$("$WEZTERM_EXE" cli spawn --new-window -- \
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

start_tmux_shell() {
  rm -f "$ENV_RESULT"
  send_text "tmux -L $TMUX_SOCKET new-session -A -s $TMUX_SESSION"$'\r'
  sleep 2
  send_text $'printf "TERM_PROGRAM=%s\\nTMUX=%s\\n" "$TERM_PROGRAM" "$TMUX" > /tmp/ralph_tmux_shell_env.txt\r'
  wait_for_file "$ENV_RESULT"
  grep -qx 'TERM_PROGRAM=WezTerm' "$ENV_RESULT"
  grep -q '^TMUX=' "$ENV_RESULT"
  log "tmux env: $(tr '\n' ' ' < "$ENV_RESULT")"
}

seed_text_clipboard() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Set-Clipboard -Value "tmux-shell-text-proof"'
}

seed_image_clipboard() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap 2,2; $bmp.SetPixel(0,0,[System.Drawing.Color]::Red); $bmp.SetPixel(1,0,[System.Drawing.Color]::Green); $bmp.SetPixel(0,1,[System.Drawing.Color]::Blue); $bmp.SetPixel(1,1,[System.Drawing.Color]::White); [System.Windows.Forms.Clipboard]::SetImage($bmp); $bmp.Dispose()'
}

trigger_shell_paste() {
  sleep 0.5
  send_text $'\e[21~'
  sleep 1.5
  send_text $'\r'
}

verify_text_case() {
  rm -f "$TEXT_RESULT"
  seed_text_clipboard
  spawn_verification_pane
  start_tmux_shell
  send_text "python3 -c 'import sys, pathlib; pathlib.Path(\"/tmp/ralph_tmux_shell_text_result.txt\").write_text(sys.argv[1])' "
  trigger_shell_paste
  wait_for_file "$TEXT_RESULT"

  local actual
  actual=$(tr -d '\r\n' < "$TEXT_RESULT")
  if [[ "$actual" != 'tmux-shell-text-proof' ]]; then
    echo "Unexpected text result: $actual" >&2
    return 1
  fi

  log "text proof: $actual"
  cleanup
}

verify_image_case() {
  rm -f "$IMAGE_RESULT"
  seed_image_clipboard
  spawn_verification_pane
  start_tmux_shell
  send_text "python3 -c 'import sys, pathlib; p = pathlib.Path(sys.argv[1]); pathlib.Path(\"/tmp/ralph_tmux_shell_image_result.txt\").write_text(str(p.resolve()) if p.exists() else \"MISSING:\" + sys.argv[1])' "
  trigger_shell_paste
  wait_for_file "$IMAGE_RESULT"

  local image_path
  image_path=$(tr -d '\r\n' < "$IMAGE_RESULT")
  if [[ ! -f "$image_path" ]]; then
    echo "Inserted image path is missing: $image_path" >&2
    return 1
  fi

  python3 - <<'PY' "$image_path"
from PIL import Image
import sys
path = sys.argv[1]
image = Image.open(path)
print(f"[verify:tmux-shell] image proof: {path} size={image.size} mode={image.mode}")
PY

  cleanup
}

verify_text_case
verify_image_case
log 'tmux shell smart paste verified'
