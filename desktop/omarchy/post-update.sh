#!/usr/bin/bash
# Omarchy updates may replace hyprland.lua. Restore only desktop declarations.
# The wallpaper assertion is a realpath check, so no theme/background work occurs
# unless its managed asset actually differs. No explicit service restarts here.
set -euo pipefail
exec "$HOME/.dotfiles/dot" apply desktop
