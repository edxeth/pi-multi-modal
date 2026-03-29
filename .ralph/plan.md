# Execution Plan: Simplify smart-paste architecture for WezTerm, WSL, tmux, and direct shell

## Source Inputs

Derived from PRD+SPEC input:
- `.pi/plans/prds/e2198673.md`
- `.pi/plans/specs/7dccc1cf.md`

Ralph reference corpus synthesized into this execution rule set:
- Work in fresh contexts; do not rely on long in-session accumulation.
- One item per iteration, one verified status transition, one commit.
- Prefer a monolithic single-repo loop over multi-agent decomposition.
- Leave append-only progress notes and make git history part of the handoff.
- Size items small enough that one item can be fully verified in one loop.
- Prioritize by architectural risk and dependency order, not list position.
- Use hard feedback loops and end-to-end proof before marking anything passing.
- Treat failures as harness data; tune the loop instead of hand-waving around regressions.
- Bias toward HITL-friendly, user-controlled lifecycle behavior; avoid hidden daemons/watchers.
- Protect source PRD/SPEC documents and keep execution artifacts separate from planning docs.
- Verify the actual failing user path, not just neighboring synthetic paths.
- Encode platform and privilege blockers up front so the loop does not discover them late.

Confirmed platform/topology facts:
- Loop generation is running from WSL Ubuntu 24.04.3 on Windows 11.
- Repo root is `/home/devkit/.pi/agent/extensions/pi-multi-modal` and maps to the Windows UNC path `\\wsl.localhost\Ubuntu\home\devkit\.pi\agent\extensions\pi-multi-modal`.
- Primary target files span both WSL and Windows:
  - `/mnt/c/Users/mysol/.wezterm.lua`
  - `/home/devkit/.zshrc`
  - `/home/devkit/.config/nvim/init.lua`
  - `/home/devkit/.pi/agent/extensions/pi-multi-modal/src/index.ts`
- The authoritative verification environment is the user’s Windows WezTerm instance hosting WSL panes, covering both direct mode and tmux mode.
- Windows tools launched from the current WSL session probed as non-admin (`IsAdmin=false`, `ADMIN_NO`) despite the user reporting an elevated WezTerm window, so each runtime iteration must re-check privilege instead of assuming inherited elevation.
- `sudo` exists in WSL but is not available non-interactively (`sudo -n true` fails), so the loop must avoid sudo unless the active item truly requires it and the operator explicitly enables it.
- The repo’s canonical package scripts currently include `npm run check`, `npm run test`, and `npm run test:integration`.

Assumptions to keep explicit:
- The Ralph loop may modify Windows/WSL dotfiles as part of implementation, but source PRD/SPEC files remain immutable.
- Because some target files live outside the git repo, each iteration must still produce at least one repo-tracked change tied to the same item so the one-commit rule remains satisfiable.
- If the runtime agent cannot re-establish access to the real Windows WezTerm verification path, that is a blocker for marking paste-related items complete.

## Objective

Implement the simplified smart-paste architecture defined by the source PRD and SPEC so that WezTerm becomes a thin router, shell/Neovim/PI each own clipboard interpretation at paste time, watcher/cache complexity is removed, and the full direct/tmux verification matrix can be proven from the real Windows WezTerm environment.

## Scope In

- Simplifying the smart-paste architecture across `/mnt/c/Users/mysol/.wezterm.lua`, `/home/devkit/.zshrc`, `/home/devkit/.config/nvim/init.lua`, and `/home/devkit/.pi/agent/extensions/pi-multi-modal/src/index.ts`
- Removing watcher/cache/state-sync clipboard behavior from the standard path
- Normalizing route ownership for shell, Neovim, and PI
- Making tmux metadata passthrough explicit and minimal
- Adding repo-tracked verification support for repeatable real-environment E2E proof
- Updating `.ralph/items.json` and `.ralph/progress.md` only as execution artifacts

## Scope Out

- Unrelated WezTerm theming/font work except where it blocks smart-paste verification
- Broad shell prompt refactors unrelated to smart paste
- Support for terminals other than WezTerm in this execution bundle
- Rewriting or editing source PRD/SPEC files
- Any packaging/publishing work not required for verification of the smart-paste stack

## Constraints

- Lifecycle must remain user-controlled; no background watcher/daemon/cached clipboard state in the standard path.
- WezTerm must converge toward route-only behavior for smart paste.
- Clipboard interpretation must live inside the active owner (shell, Neovim, PI).
- Direct shell outside tmux is a first-class failing path and must be explicitly proven, not inferred.
- tmux behavior may use metadata passthrough only for active-context signaling, not alternate clipboard processing.
- Verification must run against the real Windows WezTerm + WSL environment, not a substitute terminal path.
- Package/static/unit/integration checks must pass with exit code 0 and without bypass.
- Because Windows verification is topology-sensitive, every iteration must verify host/tool availability before coding.
- `.ralph/items.json` is the source of truth for feature-level status.

## Prioritization Strategy

Prioritize unfinished items using this order of importance:
1. The direct shell no-tmux path, because it is the active user-visible regression and the strongest proof target.
2. Architectural simplification that removes WezTerm clipboard ownership and watcher/cache behavior.
3. Owner normalization for shell, Neovim, and PI so each target has one authoritative paste implementation.
4. tmux parity after direct-mode behavior is deterministic.
5. Verification harness and regression-proofing so future loops cannot claim success without evidence.

Within the same priority tier, choose the item with the highest architectural leverage and the clearest deterministic verification path.

## Completion Definition

The execution bundle is complete only when all items in `.ralph/items.json` have `passes=true`, the required repo checks pass, and the real 12-case matrix is proven in the Windows WezTerm environment:
- shell direct text/image
- shell tmux text/image
- Neovim direct text/image
- Neovim tmux text/image
- PI direct text/image
- PI tmux text/image

Completion also requires that:
- `/mnt/c/Users/mysol/.wezterm.lua` is routing-only for smart paste
- no watcher/cache path remains in the standard flow
- source PRD/SPEC docs remain unchanged
- `.ralph/progress.md` contains one append-only entry per completed iteration
- exactly one repo commit exists for each completed item worked on in the loop

## Window Cleanup Rule

- Close any windows opened by the iteration as soon as they are no longer needed.
- Do not leave extra WezTerm or helper windows open after verification or at iteration end.
- Do not close pre-existing user windows unless the user explicitly asks for that.
