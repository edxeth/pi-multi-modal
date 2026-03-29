# Context Inputs

First read these files with the read tool:
- `.ralph/plan.md`
- `.ralph/items.json`
- `.ralph/progress.md`

Immediately after that, read these immutable source planning docs:
- `.pi/plans/prds/e2198673.md`
- `.pi/plans/specs/7dccc1cf.md`

Treat the PRD and SPEC as immutable source inputs. Do not edit them unless the user explicitly instructs you to do so.

# Fresh-Context Startup

Re-establish context from files, not prior chat history.

After reading the Ralph files and source docs, briefly inspect the repo state:
- `pwd`
- `git log --oneline -5`
- `git status --short`

Then run the startup environment checks relevant to this goal:
- `command -v wslpath`
- `wslpath -w "$PWD"`
- `test -x '/mnt/c/Program Files/WezTerm/wezterm.exe'`
- `test -x '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'`
- `test -x '/mnt/c/Program Files/PowerShell/7/pwsh.exe'`
- `'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' -NoProfile -ExecutionPolicy Bypass -Command '$id = [Security.Principal.WindowsIdentity]::GetCurrent(); $p = New-Object Security.Principal.WindowsPrincipal($id); [pscustomobject]@{ User = $id.Name; IsAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress'`
- `cmd.exe /c "fltmc >nul 2>&1 && echo ADMIN_OK || echo ADMIN_NO"`
- `command -v sudo || true`
- `sudo -n true || true`

Interpret the startup checks conservatively:
- The repo is on a WSL filesystem path that maps to a Windows UNC path. Do not assume Windows tools like UNC working directories.
- Do not assume Windows admin privileges just because the user reported an elevated WezTerm window. Trust the current probe results for the active session.
- Do not assume non-interactive sudo is available. Avoid sudo unless the current item genuinely requires it and the operator has explicitly enabled it.

# Single-Item Iteration Protocol

Work on exactly one highest-priority item where `passes=false`.
Prioritize by risk, dependencies, and architectural impact, not list order.
Do not bundle extra nearby tasks into the same iteration.
Do not change more than one item from `passes=false` to `passes=true` in one iteration.
Make exactly one git commit for the single item worked on.

Use this priority model unless direct evidence suggests a higher-risk dependency:
1. Direct shell outside tmux
2. WezTerm routing simplification
3. Owner normalization for shell, Neovim, and PI
4. tmux parity
5. Verification harness

Because some implementation targets live outside the repo (`/mnt/c/Users/mysol/.wezterm.lua`, `/home/devkit/.zshrc`, `/home/devkit/.config/nvim/init.lua`), any iteration that modifies them must also produce repo-tracked changes tied to the same item so the one-commit rule remains satisfiable.

# Stack-Aware Verification Gates

First identify the project’s canonical verification commands from repo config. This repo currently signals a Node/TypeScript package with package.json scripts.

At minimum, the following repo-tracked gates must pass with exit code 0 for any item that changes repo-owned code or verification assets:
- `cd /home/devkit/.pi/agent/extensions/pi-multi-modal && npm run check`
- `cd /home/devkit/.pi/agent/extensions/pi-multi-modal && npm run test`
- `cd /home/devkit/.pi/agent/extensions/pi-multi-modal && npm pack --dry-run`

When the current item changes paste behavior or verification logic, also run the applicable integration/E2E gates:
- `cd /home/devkit/.pi/agent/extensions/pi-multi-modal && npm run test:integration` (if the item touches code paths covered by integration tests or adds integration coverage)
- the goal-specific smart-paste E2E verification for the affected user path(s) using the real Windows WezTerm + WSL environment

For this goal, preferred E2E proof is real-path verification against:
- direct shell outside tmux
- direct Neovim outside tmux
- direct PI outside tmux
- shell inside tmux
- Neovim inside tmux
- PI inside tmux

If the active session is blocked from driving the real Windows GUI path by focus/UIPI/admin boundaries, acceptable fallback proof may use the closest automatable path for the same owner/route, provided you also record the exact blocker commands and outcomes in `.ralph/progress.md`.

If the repo already contains a tracked smart-paste E2E harness, use it and record the exact command.
If it does not yet exist, the highest-priority unfinished verification item is to add one. Until then, any item that changes paste behavior must still execute the exact WezTerm/PowerShell/WSL commands needed to prove the affected path and record those commands plus outcomes in `.ralph/progress.md`.

Do not mark an item complete based only on synthetic route injection if the real Windows GUI keybinding path is still practically testable from the active session. If that path is blocked by verified environment constraints, you may use the closest automatable proof for the same owner/route, but you must record the blocker evidence and the substituted proof path explicitly in `.ralph/progress.md`.

# No-Bypass Rules

- Do not skip checks or weaken tests to pass.
- Do not use bypass flags or failure masking patterns such as `--no-verify`, `|| true`, suppressing failures, or deleting/neutralizing tests.
- Do not claim success without evidence from executed checks.
- Do not replace a failing direct-path proof with a neighboring synthetic-path proof when the direct path remains practically testable from the active session.
- If the direct path is blocked by verified environment constraints, you may use the closest automatable proof path, but only with explicit blocker evidence recorded in `.ralph/progress.md`.
- Do not reintroduce clipboard watchers, cache files, or hidden background helpers into the standard flow.

# Source-Doc Protection

- Do not edit source PRD/SPEC planning docs unless the user explicitly instructed that.
- Update only Ralph execution artifacts and implementation files unless explicit instructions say otherwise.
- Keep `.ralph/plan.md`, `.ralph/items.json`, and `.ralph/progress.md` as execution artifacts, not product/spec docs.

# Progress File Rules

- Append exactly one concise entry to `.ralph/progress.md` per iteration.
- Treat `.ralph/progress.md` as append-only; never rewrite or truncate prior entries.
- Each entry must include:
  - item worked on
  - key decisions
  - files changed
  - verification commands run and outcomes
  - notes for the next fresh-context iteration

# Items File Rules

- Do not delete items.
- Do not rewrite any existing `description` or `steps`.
- Update status via `passes` only.
- If a previously passing item regresses, set `passes` back to `false` and explain why in `regression_notes`.
- Never set `passes=true` without full verification evidence for that item.

# Loop Control Promise Contract

End the iteration with exactly one control tag on the last non-empty line.
Emit `<promise>NEXT</promise>` only when exactly one item was completed and fully verified.
Emit `<promise>COMPLETE</promise>` only when all items in `.ralph/items.json` are `passes=true` and all required verification gates pass fully with no bypass.
Do not emit any other control promise.

# Window Cleanup

- Close any windows the agent opened once they are no longer needed.
- Do not leave extra WezTerm or helper windows open at the end of a step or iteration.
- Never close the user's pre-existing windows; only close windows created by the current iteration unless the user explicitly instructs otherwise.
- If the current E2E approach starts looping on UAC/elevation/window-routing without yielding user-path proof, stop that approach, record the blocker, clean up agent-opened windows, and move to the next iteration instead of repeating the same path.
