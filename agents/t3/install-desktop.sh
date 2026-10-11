#!/usr/bin/env bash
# Install or update the T3 Code Nightly desktop app from the AUR. Run in
# Tobias's terminal with the app closed: makepkg refuses to build as root and
# the install needs sudo.
#
# Install the AUR release, not the older package in Omarchy's repository.
# Build before removing stable, so a download/build failure leaves it installed.
# `omarchy pkg aur add` cannot do this: it does nothing when the package is
# already installed, and its yay resolves the same-named package from Omarchy's
# repository before the AUR. It accepts no `aur/` prefix. Hence the raw AUR
# queries, makepkg and `pacman -U` of the built file.
set -euo pipefail

die() { printf '[t3-desktop] %s\n' "$*" >&2; exit 1; }
[[ $(id -u) != 0 ]] || die 'Run as the desktop user, not root'
if pgrep -u "$(id -u)" -f '^(/usr/lib/t3code[^/]*|/opt/t3code-nightly-bin)/' >/dev/null; then
  die 'Quit the T3 desktop app first'
fi

aur_version="$(yay -Si aur/t3code-nightly-bin | awk -F': *' '$1 ~ /^Version/ { print $2 }')"
[[ -n $aur_version ]] || die 'Could not determine the AUR nightly desktop version'
installed_version="$(pacman -Q t3code-nightly-bin 2>/dev/null | awk '{ print $2 }' || true)"
if [[ -n $installed_version ]] && [[ $(vercmp "$aur_version" "$installed_version") -le 0 ]]; then
  printf '[t3-desktop] t3code-nightly-bin %s is current\n' "$installed_version"
  exit 0
fi
build_dir="$(mktemp -d "$HOME/.cache/t3-desktop.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
git clone --depth 1 https://aur.archlinux.org/t3code-nightly-bin.git "$build_dir"
(cd "$build_dir" && makepkg --clean --noconfirm)
mapfile -t packages < <(cd "$build_dir" && makepkg --packagelist)
[[ ${#packages[@]} == 1 && -f ${packages[0]} ]] || die 'Expected one built nightly desktop package'
sudo -v
if pacman -Q t3code-bin >/dev/null 2>&1; then
  omarchy pkg drop t3code-bin
fi
sudo pacman -U --noconfirm "${packages[0]}"
