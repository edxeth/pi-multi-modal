#!/usr/bin/env bash
set -euo pipefail

WEZTERM_EXE=${WEZTERM_EXE:-'/mnt/c/Program Files/WezTerm/wezterm.exe'}
POWERSHELL_EXE=${POWERSHELL_EXE:-'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'}
REPO_ROOT=/home/devkit/.pi/agent/extensions/pi-multi-modal
TEXT_SESSION=/tmp/ralph_tmux_pi_text.session
IMAGE_SESSION=/tmp/ralph_tmux_pi_image.session
ENV_RESULT=/tmp/ralph_tmux_pi_env.txt
TMUX_SOCKET="ralph-smart-paste-pi-$$"
TMUX_SESSION=verify
CURRENT_PANE_ID=

log() {
  printf '[verify:tmux-pi] %s\n' "$1"
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

session_contains() {
  local path=$1
  local needle=$2
  python3 - <<'PY' "$path" "$needle"
from pathlib import Path
import sys
path = Path(sys.argv[1])
needle = sys.argv[2]
if not path.exists():
    raise SystemExit(1)
raise SystemExit(0 if needle in path.read_text(errors='replace') else 1)
PY
}

wait_for_session_contains() {
  local path=$1
  local needle=$2
  for _ in $(seq 1 120); do
    if session_contains "$path" "$needle"; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for ${needle} in ${path}" >&2
  return 1
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
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Set-Clipboard -Value "tmux-pi-text-proof"'
}

seed_image_clipboard() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command 'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap 2,2; $bmp.SetPixel(0,0,[System.Drawing.Color]::Red); $bmp.SetPixel(1,0,[System.Drawing.Color]::Green); $bmp.SetPixel(0,1,[System.Drawing.Color]::Blue); $bmp.SetPixel(1,1,[System.Drawing.Color]::White); [System.Windows.Forms.Clipboard]::SetImage($bmp); $bmp.Dispose()'
}

start_tmux_pi() {
  local session=$1
  rm -f "$ENV_RESULT" "$session"
  spawn_verification_pane
  send_text "tmux -L $TMUX_SOCKET new-session -A -s $TMUX_SESSION"$'\r'
  sleep 2
  send_text $'printf "TERM_PROGRAM=%s\nTMUX=%s\n" "$TERM_PROGRAM" "$TMUX" > /tmp/ralph_tmux_pi_env.txt\r'
  wait_for_file "$ENV_RESULT"
  grep -qx 'TERM_PROGRAM=WezTerm' "$ENV_RESULT"
  grep -q '^TMUX=' "$ENV_RESULT"
  log "tmux env: $(tr '\n' ' ' < "$ENV_RESULT")"
  send_text "script -q -f $session -c 'pi'"$'\r'
  wait_for_session_contains "$session" 'PI_SMART_PASTE=MQ=='
  sleep 4
  if session_contains "$session" 'Press any key to continue'; then
    send_text ' '
    sleep 4
  fi
}

stop_tmux_pi() {
  send_text $'\x03'
  sleep 1
  cleanup
}

verify_text_case() {
  seed_text_clipboard
  start_tmux_pi "$TEXT_SESSION"
  send_text $'\e[23~'
  sleep 4
  stop_tmux_pi

  local actual
  actual=$(python3 - <<'PY' "$TEXT_SESSION"
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text(errors='replace')
text = re.sub(r'\x1b\][^\x07]*(\x07|\x1b\\)', '', text)
text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
text = re.sub(r'\x1b[@-_]', '', text)
match = re.search(r'>\s*(tmux-pi-text-proof)', text)
if not match:
    raise SystemExit(1)
print(match.group(1))
PY
)

  if [[ "$actual" != 'tmux-pi-text-proof' ]]; then
    echo "Unexpected text result: $actual" >&2
    return 1
  fi

  log "text proof: $actual"
}

verify_image_case() {
  seed_image_clipboard
  start_tmux_pi "$IMAGE_SESSION"
  send_text $'\e[23~'
  sleep 5
  stop_tmux_pi

  local image_path
  image_path=$(python3 - <<'PY' "$IMAGE_SESSION"
from pathlib import Path
import re
import sys
text = Path(sys.argv[1]).read_text(errors='replace')
text = re.sub(r'\x1b\][^\x07]*(\x07|\x1b\\)', '', text)
text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
text = re.sub(r'\x1b[@-_]', '', text)
match = re.search(r'@(/tmp/clipboard-[^\s]+)', text)
if not match:
    raise SystemExit(1)
print(match.group(1))
PY
)

  if [[ ! -f "$image_path" ]]; then
    echo "Inserted image path is missing: $image_path" >&2
    return 1
  fi

  python3 - <<'PY' "$image_path"
from PIL import Image
import sys
path = sys.argv[1]
image = Image.open(path)
print(f"[verify:tmux-pi] image proof: {path} size={image.size} mode={image.mode}")
PY
}

verify_text_case
verify_image_case
log 'tmux PI smart paste verified'
