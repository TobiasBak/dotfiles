# AGENTS.md

Guidance for agents working under `nixos/`.

## Fast WSL rebuilds

Use `../rebuild-wsl.sh --nixos-only` when only the WSL NixOS configuration, including its embedded Home Manager configuration, needs to be applied. The flag skips only the mutable bootstrap work: user config link repair, Codex/Pi agent pnpm installs, and skill link refresh.

Use full `../rebuild-wsl.sh` when changing bootstrap/link behavior or when agent tools and skill links must be repaired.

Before applying a WSL switch, build the exact toplevel:

```bash
nix build --no-link .#nixosConfigurations.wsl.config.system.build.toplevel
```

## Flake source visibility

This repo is a Git worktree. Nix flakes ignore untracked files when evaluating from the repo path. After adding files used by the flake, run:

```bash
git add -N <new-file-or-dir>
```

Do this before `nix build` or `nixos-rebuild` so evaluation sees the new files without staging their contents for commit.

## Packages

Machine/system packages belong in `hosts/<host>/configuration.nix`, not bootstrap scripts.

For npm CLIs that are not in nixpkgs:

- Verify the actual package identity first. Do not trust a binary name match; for example, nixpkgs `vp` is not Vite+.
- Add a small local package under `packages/<name>/` using `buildNpmPackage`.
- Commit both `package.json` and `package-lock.json`.
- Pin `npmDepsHash` from the real lock file, not a temporary package with different root metadata.
- Wrap only the expected command binaries into `$out/bin`.
- Verify with the built command and the host toplevel build before applying.

For `vite-plus`, the intended npm package is `vite-plus` and the global CLI is `vp`.
