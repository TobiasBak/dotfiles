# AGENTS.md

## Where to work

Omarchy is the only workstation target. `agents/`, `desktop/` and `cli/` own
its modules; `packages.toml` and `mise.toml` own extra packages and global tools.
`nixos/` owns only tobias-serv01. Before server work, read `nixos/README.md`
and follow its detached remote activation procedure. Never run Nix on Omarchy.

## Commands

- `./verify`: repository gate, including black-box tests in fake homes.
- `./dot check --json`: read-only live drift. Exit 0 clean, 1 drift, 2 error.
- `./dot apply --dry-run`: live diff and proposed actions without mutations.
- `./dot apply`: apply from the stable checkout, only with explicit approval.
- Add `agents`, `desktop`, `cli`, `packages` or `mise` to scope a command.

Live links go through `~/.dotfiles`, normally `~/code/dotfiles`. Worktree
edits are not live. Verify effective targets and existing running processes;
config parsing or a fresh inspection process does not prove runtime adoption.
Mutable app settings are merged, never linked into Git.

## Boundaries

Read `omarchy/README.md` and the Omarchy skill before desktop or system changes.
Store only overrides, never copies of Omarchy defaults. Never edit
`/usr/share/omarchy`. Unknown live customizations are capture drift; do not
reset them. The migration helpers accept only audited legacy content and
back it up before restoring installed defaults.

Packages go through Omarchy. Agents use background
`pkexec /usr/share/omarchy/bin/omarchy-pkg-add <pkgs>`; Tobias approves polkit.
AUR builds require Tobias's terminal. Global tools go through mise and pnpm.
Long jobs use `systemd-run --user --slice=app-t3code-agents.slice`; scratch
files live under `~/.cache/agent-tmp`, not RAM-backed `/tmp`.

T3 owns its service and runtime. This repo owns its drop-in, memory slice
and update timer. Never restart or update T3 without Tobias: every hosted
agent is interrupted. The detached nightly updater is
`systemctl --user start --no-block t3code-update.service`.

Vault skills live in the sibling `vault-public/skills`.
Pi's retired workspace-view v3 snapshot extension stays disabled. The sibling
`pi-workspace-view` repo owns context-construction experiments; its prototype
is not installed by this repo. `./dot apply agents` removes only the retired
snapshot entry, preserving other Pi extensions and Omarchy's skills.
No separate bootstrap or installer.

Keep secrets and mutable runtime state out of Git. Never hand-edit generated
files or `CHANGELOG.md`. Server hardware files and `flake.lock` remain
generated. Installers, applies and server activations require explicit approval.
