# Dotfiles

Personal overrides for an Omarchy workstation, plus the unchanged NixOS
configuration for `tobias-serv01`. Omarchy never installs or runs Nix.

## Layout

- `dot`: declarative apply and drift check.
- `packages.toml`: extra system packages, with consumer notes.
- `mise.toml` and generated `mise.lock`: global developer tools, settings and environment.
- `agents/`: global instructions for Claude, Codex, Pi and OpenCode, provider settings, skills, T3 and the OpenCode free-model tracker.
- `desktop/`: monitor/animation overrides, transparent bar, wallpaper,
  Stremio, Taildrop and the LAN-only serv01 NAS automount.
- `cli/`: Git overrides and hunk configuration.
- `omarchy/README.md`: workstation setup, verification and manual recovery.
- `nixos/`: serv01 only. See `nixos/README.md` for safe rebuilds.

## Use

Keep `dotfiles` and `vault-public` as sibling checkouts. The sibling
`pi-workspace-view` repo holds ongoing context-construction experiments; its
retired v3 snapshot extension is disabled and no prototype is installed.
The stable link `~/.dotfiles` points to the checkout used for live applies.

```sh
./verify
./dot check
./dot apply --dry-run
./dot apply
./dot check --json
```

Apply requires approval. Review its dry-run diff first. It installs missing
repo packages, configures mise, creates links, merges managed settings and
enables user services. It never restarts T3 or resets unknown customizations.
AUR installs, secrets, process restarts and privileged NAS unit setup remain
explicit manual items. See [NAS setup and manual restore](omarchy/README.md#nas-mount).
The NAS mount uses the home LAN only; it fails away from home.

`check` exits 0 when clean, 1 when drift remains, and 2 on an error. JSON
reports each item's module, target, state, detail and fix owner:
`apply`, `tobias` or `capture`. Only `tobias` items may remain after a
completed apply. Scope either command with module names, for example
`./dot apply agents`; this replaces the old agent-context installer.

`./dot apply mise` links `~/.config/mise/config.toml` and `mise.lock` to
this checkout, backing up divergent files. `mise use -g` follows the config
link. Regenerate the tracked lock with `mise lock --global`; see the
[mise lockfile docs](https://mise.jdx.dev/dev-tools/mise-lock.html#global-lockfiles).
T3's nightly updater keeps its rolling CLI pin in the machine-local
`~/.config/mise/config.local.toml`. Its optional `mise.local.lock` stays
machine-local too; `conf.d` fragments would share the tracked global lock.

Omarchy owns all stock terminal, theme and desktop defaults. Live changes
to its seeded configs are drift unless this repo captures their overrides.

## Privacy

Managed agent settings disable optional telemetry and feedback. They do not
control account-level training preferences. Set those separately in
[ChatGPT Data controls](https://chatgpt.com/#settings/DataControls) and
[Claude Privacy](https://claude.ai/settings/data-privacy-controls).
