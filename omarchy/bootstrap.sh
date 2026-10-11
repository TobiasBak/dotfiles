#!/usr/bin/env bash
# Native Omarchy setup. No Nix, Home Manager, shell changes or disk operations.
# Close the T3 desktop app first. Run in a terminal for sudo prompts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
log() { printf '[omarchy] %s\n' "$*"; }
die() { printf '[omarchy] %s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || die 'Usage: omarchy/bootstrap.sh (TPM/disk changes are not part of this setup)'
[[ $(id -u) != 0 ]] || die 'Run as the desktop user, not root'
# shellcheck disable=SC1091
source /etc/os-release
[[ ${ID:-} == omarchy ]] || die 'This entrypoint is only for Omarchy; use the rebuild scripts on NixOS'
for tool in mise omarchy yay pacman python3 systemctl tailscale git makepkg ss chromium; do
  command -v "$tool" >/dev/null || die "Required tool is missing: $tool"
done
if pgrep -u "$(id -u)" -f '^(/usr/lib/t3code[^/]*|/opt/t3code-nightly-bin)/' >/dev/null; then
  die 'Quit the T3 desktop app first; it owns the database and port 3773'
fi
if [[ ! -f $HOME/.config/systemd/user/t3code.service ]] && ss -Hltn 'sport = :3773' | grep -q .; then
  die 'Port 3773 is occupied outside t3code.service; stop its owner first'
fi
[[ -d $REPO_DIR/../vault-public ]] || die 'Clone vault-public next to dotfiles first'
[[ -f $REPO_DIR/../pi-workspace-view/src/snapshot.ts ]] || die 'Clone pi-workspace-view next to dotfiles first'

# Stable entrypoint for the update timer. Never replace a real directory.
if [[ -e $HOME/.dotfiles && ! -L $HOME/.dotfiles ]]; then
  die "$HOME/.dotfiles is a real directory; move it aside before setup"
fi
if [[ -e $HOME/.agents/skills/playwright-cli && ! -L $HOME/.agents/skills/playwright-cli ]]; then
  die "$HOME/.agents/skills/playwright-cli is a real directory; move it aside before setup"
fi
ln -sfn "$REPO_DIR" "$HOME/.dotfiles"
python3 "$REPO_DIR/scripts/install-agent-context.py"
mise settings set npm.package_manager pnpm
# pnpm 11 is the supported installer for the nightly CLI.
mise use --global --quiet pnpm@11.13.1
# Developer CLIs that NixOS hosts get from nixos/packages/developer-cli.nix.
# Omarchy's ~/.local/bin wrappers install the agent CLIs on first use.
MISE_MINIMUM_RELEASE_AGE=0 mise use --global --quiet \
  uv@latest go@latest npm:vite-plus@latest npm:@playwright/cli@latest
# playwright-cli has no bundled browser; it drives Omarchy's Chromium.
mise set --global PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium
# The skill ships inside the installed version. Rerun setup after upgrading it.
# playwright-cli prints its path, relative to the cwd, only to coding agents.
playwright_skill="$(cd / && CLAUDECODE=1 mise exec npm:@playwright/cli -- playwright-cli --help | sed -n 's/^ *Agent skill: //p')"
playwright_skill="$(cd / && realpath -e "${playwright_skill:-missing}")" ||
  die 'playwright-cli did not report its agent skill'
ln -sfnT "$(dirname "$playwright_skill")" "$HOME/.agents/skills/playwright-cli"

# GitHub goes over HTTPS with gh's credentials; no SSH key is installed, so
# rewrite SSH remotes. Resolve gh through PATH: `gh auth setup-git` pins the
# current mise install path, which a gh upgrade deletes.
git config --global --unset-all url.https://github.com/.insteadOf || true
git config --global --add url.https://github.com/.insteadOf git@github.com:
git config --global --add url.https://github.com/.insteadOf ssh://git@github.com/
for host in github.com gist.github.com; do
  git config --global --unset-all "credential.https://$host.helper" || true
  git config --global --add "credential.https://$host.helper" ''
  git config --global --add "credential.https://$host.helper" '!gh auth git-credential'
done

# Backup all app state before changing its settings or starting a newer server.
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import shutil
import sqlite3
import json
home = Path.home()
state = home / '.t3/userdata'
if state.exists():
    backup = home / '.local/state/t3-migration' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.mkdir(mode=0o700)
    # The background service may already be running on a rerun. Use SQLite's
    # online backup API instead of copying a live database/WAL pair.
    shutil.copytree(state, backup / 'userdata', ignore=shutil.ignore_patterns('*.sqlite', '*.sqlite-wal', '*.sqlite-shm'))
    for database in state.glob('*.sqlite'):
        with sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True) as source, sqlite3.connect(backup / 'userdata' / database.name) as target:
            source.backup(target)
    print(f'[omarchy] T3 state backup: {backup}')
state.mkdir(parents=True, exist_ok=True)
settings = state / 'desktop-settings.json'
value = json.loads(settings.read_text()) if settings.exists() else {}
value['localEnvironmentEnabled'] = False
settings.write_text(json.dumps(value, indent=2) + '\n')
# T3 disables Pi unless configured; agent teams delegate to it. The server
# watches this file, so a rerun applies without a restart.
settings = state / 'settings.json'
value = json.loads(settings.read_text()) if settings.exists() else {}
pi = value.setdefault('providerInstances', {}).setdefault('pi', {'driver': 'pi', 'config': {}})
pi['enabled'] = True
settings.write_text(json.dumps(value, indent=2) + '\n')
PY

# System packages agents need. xorg-server-xvfb provides xvfb-run for headless
# desktop-app smoke tests, such as Orderready's `tools/or dev`.
omarchy pkg add xorg-server-xvfb

# Install the AUR release, not the older package in Omarchy's repository.
# Build before removing stable, so a download/build failure leaves it installed.
# `omarchy pkg aur add` cannot do this: it does nothing when the package is
# already installed, and its yay resolves the same-named package from Omarchy's
# repository before the AUR. It accepts no `aur/` prefix. Hence the raw AUR
# queries, makepkg and `pacman -U` of the built file.
aur_version="$(yay -Si aur/t3code-nightly-bin | awk -F': *' '$1 ~ /^Version/ { print $2 }')"
[[ -n $aur_version ]] || die 'Could not determine the AUR nightly desktop version'
installed_version="$(pacman -Q t3code-nightly-bin 2>/dev/null | awk '{ print $2 }' || true)"
if [[ -z $installed_version ]] || [[ $(vercmp "$aur_version" "$installed_version") -gt 0 ]]; then
  build_dir="$(mktemp -d)"
  trap 'rm -rf "$build_dir"' EXIT
  git clone --depth 1 https://aur.archlinux.org/t3code-nightly-bin.git "$build_dir"
  (cd "$build_dir" && makepkg --clean --noconfirm)
  mapfile -t packages < <(cd "$build_dir" && makepkg --packagelist)
  [[ ${#packages[@]} == 1 && -f ${packages[0]} ]] || die 'Expected one built nightly desktop package'
  sudo -v
  omarchy pkg drop t3code-bin
  sudo pacman -U --noconfirm "${packages[0]}"
fi

# Omarchy's server stays loopback-only. Tailscale Serve provides Tailnet HTTPS.
# Native units live here, never under nixos/ or generated by Home Manager.
mkdir -p "$HOME/.config/systemd/user/t3code.service.d"
install -m 644 "$SCRIPT_DIR/systemd/t3code-local.conf" "$HOME/.config/systemd/user/t3code.service.d/local.conf"
for unit in app-t3code.slice t3code-update.service t3code-update.timer; do
  install -m 644 "$SCRIPT_DIR/systemd/$unit" "$HOME/.config/systemd/user/$unit"
done
mkdir -p "$HOME/.config/user-tmpfiles.d"
install -m 644 "$SCRIPT_DIR/systemd/agent-tmp.conf" "$HOME/.config/user-tmpfiles.d/agent-tmp.conf"
systemd-tmpfiles --user --create agent-tmp.conf
systemctl --user daemon-reload
systemctl --user enable --now systemd-tmpfiles-clean.timer
bash "$SCRIPT_DIR/t3-nightly.sh" --install-service
# A running server keeps its old environment and slice until restarted. Hosted
# agents were stopped before setup, so restarting here interrupts nothing.
systemctl --user try-restart t3code.service
sudo loginctl enable-linger "$(id -un)"
sudo systemctl enable --now tailscaled.service
sudo tailscale set --operator="$(id -un)"
if tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --yes http://127.0.0.1:3773
else
  log 'Manual step: sudo tailscale up, then rerun this setup'
  exit 2
fi
systemctl --user enable --now t3code-update.timer
systemctl --user is-active --quiet t3code.service || die 'T3 service is not running'
log 'Native Omarchy setup complete. Open T3 Code Nightly and run t3 pair.'
log 'Remote backups are separate; credentials are never installed by this bootstrap.'
