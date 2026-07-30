# AGENTS.md

Guidance for agents working in this dotfiles repo.

## Active configuration

Files under `configs/` affect a machine only through managed links. Verify the effective target before assuming an edit is active. For long-running applications, also exercise the user's real launch path against the existing process; a valid file or fresh config-inspection process does not prove that the running application loaded it.

NixOS and Home Manager links are declared under `nixos/home/tobias/`; Windows links are declared in `windows/configuration.winget`. If an expected target is a real file or directory instead of a link, report it and recommend the appropriate rebuild rather than overwriting it.

## Agent skills

Personal Pi and Codex skills live in the sibling `../skills` repository, not here. Its installer discovers directories containing `SKILL.md`; use this repository's WSL or native NixOS rebuild entrypoint to refresh installed links.

## NixOS servers

Before changing or remotely rebuilding a NixOS server, read `nixos/README.md` and follow its remote server operation guidance. It is authoritative for SSH, Tailscale, and rebuild safety.

## Installed T3 Code service

The `pc` host uses T3 Code's official pinned per-user background service on the npm nightly channel. NixOS owns user lingering and the Tailnet-only port `3773` firewall rule; it does not own the service unit or runtime. Update through `npx t3@nightly service update`, not a source checkout. Inspect the live unit and process before operational changes, and account for an update or restart terminating its hosted coding-agent sessions.

## Installers and rebuilds

Do not run installers, rebuild entrypoints, or Windows winget configuration without explicit user approval. They install packages and mutate user or system configuration.
