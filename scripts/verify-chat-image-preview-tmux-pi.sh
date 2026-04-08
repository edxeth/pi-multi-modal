#!/usr/bin/env bash
set -euo pipefail

CLAUDE_TMUX_SOCKET_DIR=${CLAUDE_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/claude-tmux-sockets}
SOCKET=${SOCKET:-$CLAUDE_TMUX_SOCKET_DIR/pi-multimodal-chat-preview.sock}
SESSION=${SESSION:-pi-multimodal-chat-preview}
TARGET="$SESSION":0.0
REPO_ROOT=/home/devkit/.pi/agent/extensions/pi-multi-modal
LOG=${LOG:-/tmp/pi-multimodal-chat-preview.log}
PROMPT=${PROMPT:-'Reply with exactly OK. Then stop. @./test-fixtures/general.png'}
IDLE_SECONDS=${IDLE_SECONDS:-3}

log() {
  printf '[verify:tmux-chat-preview] %s\n' "$1"
}

cleanup() {
  tmux -S "$SOCKET" kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$CLAUDE_TMUX_SOCKET_DIR"
rm -f "$LOG"
TMUX='' tmux -f /dev/null -S "$SOCKET" new -d -s "$SESSION" -n pi "cd $REPO_ROOT && exec zsh -i"

log "socket=$SOCKET"
log "session=$SESSION"
log "raw_log=$LOG"

# Run pi with Ghostty-like env so pi-tui uses kitty graphics through tmux passthrough.
tmux -S "$SOCKET" send-keys -t "$TARGET" -- $'cd /home/devkit/.pi/agent/extensions/pi-multi-modal\n'
tmux -S "$SOCKET" send-keys -t "$TARGET" -- $'TERM_PROGRAM=ghostty COLORTERM=truecolor script -q -f -c '\''pi --no-extensions -e ./src/index.ts --no-session'\'' /tmp/pi-multimodal-chat-preview.log' Enter

python3 - <<'PY'
from pathlib import Path
import time
p=Path('/tmp/pi-multimodal-chat-preview.log')
for _ in range(60):
    if p.exists() and p.stat().st_size > 0:
        raise SystemExit(0)
    time.sleep(0.5)
raise SystemExit('timed out waiting for pi log startup')
PY

# Give pi a moment to finish initial paint.
sleep 3

tmux -S "$SOCKET" send-keys -t "$TARGET" -l -- "$PROMPT"
tmux -S "$SOCKET" send-keys -t "$TARGET" Enter

python3 - <<'PY'
from pathlib import Path
import re
import time

def strip_ansi(text: str) -> str:
    text = re.sub(r'\x1b\][^\x07]*(\x07|\x1b\\)', '', text)
    text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'\x1b[@-_]', '', text)
    return text

p=Path('/tmp/pi-multimodal-chat-preview.log')
needle='@./test-fixtures/general.png'
fallback='📎 1 image attached'
for _ in range(120):
    if p.exists():
        text=p.read_text(errors='replace')
        clean=strip_ansi(text)
        if needle in clean and fallback in clean:
            raise SystemExit(0)
    time.sleep(0.5)
raise SystemExit('timed out waiting for prompt + tmux fallback image message')
PY

IDLE_SECONDS="$IDLE_SECONDS" python3 - <<'PY'
from pathlib import Path
import os
import re
import time

def strip_ansi(text: str):
    text = re.sub(r'\x1b\][^\x07]*(\x07|\x1b\\)', '', text)
    text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'\x1b[@-_]', '', text)
    return text

p=Path('/tmp/pi-multimodal-chat-preview.log')
idle_seconds=float(os.environ['IDLE_SECONDS'])
last=None
stable=0
for _ in range(30):
    size=p.stat().st_size
    if size == last:
        stable += 1
    else:
        stable = 0
    last = size
    if stable >= 4:
        break
    time.sleep(0.5)
text=p.read_text(errors='replace')
wrapped=text.count('\x1bPtmux;\x1b\x1b_G')
deletes=text.count('a=d,d=I')
if wrapped != 0:
    raise SystemExit(f'unexpected tmux-wrapped kitty image sequences found before idle: {wrapped}')
if deletes != 0:
    raise SystemExit(f'unexpected kitty delete sequences found before idle: {deletes}')
size_before=len(text)
time.sleep(idle_seconds)
text2=p.read_text(errors='replace')
delta=len(text2)-size_before
wrapped_after=text2.count('\x1bPtmux;\x1b\x1b_G')
deletes_after=text2.count('a=d,d=I')
clean=strip_ansi(text2)
if delta != 0:
    raise SystemExit(f'output changed during idle window (delta={delta})')
if wrapped_after != 0:
    raise SystemExit(f'unexpected tmux-wrapped kitty image sequences found after idle: {wrapped_after}')
if deletes_after != 0:
    raise SystemExit(f'unexpected kitty delete sequences found after idle: {deletes_after}')
if '📎 1 image attached' not in clean:
    raise SystemExit('tmux fallback image message missing')
if 'OK' not in clean:
    raise SystemExit('assistant proof text missing')
print(f'[verify:tmux-chat-preview] preview wrapped sequences: {wrapped_after}')
print(f'[verify:tmux-chat-preview] kitty delete sequences: {deletes_after}')
print(f'[verify:tmux-chat-preview] idle delta: {delta}')
print('[verify:tmux-chat-preview] assistant proof: OK')
PY

log 'tmux chat image preview verified'
