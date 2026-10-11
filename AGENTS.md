# AGENTS.md

Guidance for agents working in this dotfiles repo.

## Active configuration

Files under `configs/` affect a machine only through managed links. Verify the effective target before assuming an edit is active. For long-running applications, also exercise the user's real launch path against the existing process; a valid file or fresh config-inspection process does not prove that the running application loaded it.

For agent context only on any Unix workstation, use `python3 scripts/install-agent-context.py`; it needs no Nix or OS bootstrap. It resolves sibling repositories independently of username and hostname, backs up conflicting entries, preserves existing skills, and merges Pi settings rather than linking mutable local state into Git.

NixOS and Home Manager links are declared under `nixos/home/tobias/`; Windows links are declared in `windows/configuration.winget`. If an expected target is a real file or directory instead of a link, report it and recommend the appropriate rebuild rather than overwriting it.

## Agent skills

Vault-maintained agent skills live in the sibling `../vault-public` repository under `skills/`, not here. Its `scripts/install-skills.sh` links them into `~/.agents/skills`; use `scripts/install-agent-context.py` for agent-only installs, or the WSL/native NixOS rebuild entrypoint when rebuilding those systems. Package-provided skills such as `playwright-cli` are declared in `nixos/home/tobias/common.nix` under the same shared user directory. Codex and Pi discover it directly; `~/.claude/skills` links to it.

## NixOS servers

Before changing or remotely rebuilding a NixOS server, read `nixos/README.md` and follow its remote server operation guidance. It is authoritative for SSH, Tailscale, and rebuild safety.

## Omarchy

Omarchy and NixOS are separate setups. `omarchy/bootstrap.sh` uses mise, Omarchy's `omarchy pkg` commands and native systemd user units in `omarchy/systemd/`; it must not install Nix or activate Home Manager. `nixos/` is only for NixOS and WSL. Share program configuration and agent instructions through `configs/` and `scripts/`, not OS modules. Before changing Omarchy setup, read `omarchy/README.md`. Omarchy owns desktop configuration; do not manage Hyprland or other Omarchy-owned files from this repository. T3's nightly service updater is `t3code-update.timer`.

## Installed T3 Code service

The NixOS `pc` host uses T3 Code's official pinned per-user background service on the nightly channel. NixOS owns user lingering and the Tailnet-only port `3773` firewall rule; it does not own the service unit or runtime. OS rebuilds do not update T3. Update it separately through `npx --yes t3@nightly update --channel nightly --yes`, not a source checkout.

An agent running inside T3 Code must detach the update from `t3code.service` so stopping that service does not kill the updater. Use this one command:

```sh
systemd-run --user --collect --unit=t3code-update --service-type=exec --working-directory=/home/tobias -- /run/current-system/sw/bin/npx --yes t3@nightly update --channel nightly --yes
```

The thread will disconnect briefly while the service replaces itself; reconnect to the same thread after `pc:3773` returns. Inspect the live unit and process before other operational changes, and account for any update or restart terminating hosted coding-agent sessions.

## Installers and rebuilds

Do not run installers, rebuild entrypoints, or Windows winget configuration without explicit user approval. They install packages and mutate user or system configuration.
