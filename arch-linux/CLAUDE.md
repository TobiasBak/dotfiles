# Arch Linux Configuration

This folder contains configuration files for an Arch Linux desktop environment.

## Desktop Environment Stack

- **Window Manager**: niri (scrollable-tiling Wayland compositor)
- **Status Bar**: quickshell (Qt/QML-based shell)
- **Terminal**: alacritty
- **Shell**: zsh with Oh My Zsh (robbyrussell theme)
- **Notifications**: mako
- **Application Launcher**: fuzzel (configured in niri)

## Folder Structure

```
arch-linux/
├── .config/
│   ├── alacritty/          # Terminal emulator config
│   │   └── alacritty.toml
│   ├── Code/               # VS Code settings
│   ├── discord/            # Discord settings
│   │   └── settings.json   # Includes MINIMIZE_TO_TRAY: false
│   ├── htop/               # System monitor config
│   ├── mako/               # Notification daemon config
│   ├── neofetch/           # System info display config
│   ├── niri/               # Window manager config
│   │   └── config.kdl      # KDL format configuration
│   └── quickshell/         # Status bar (see below)
├── .claude/                # Claude Code local settings
├── wallpapers/             # Desktop wallpapers
├── .zshrc                  # Zsh configuration
├── 99-input-fix.rules      # udev rules for input devices
└── install.sh              # Installation script
```

## Quickshell Components

The status bar is built with quickshell using QML:

```
quickshell/
├── shell.qml               # Main shell entry point
├── components/
│   ├── PopupButton.qml     # Reusable button+popup component
│   ├── AudioControl.qml    # Volume control (output + mic)
│   ├── SysTray.qml         # System tray popup
│   ├── Taskbar.qml         # Running windows (left side)
│   ├── Workspaces.qml      # Workspace indicators (center)
│   ├── Clock.qml           # Date/time display (right side)
│   ├── ClipboardPopup.qml  # Copy notification overlay
│   └── VoiceIndicator.qml  # Mic recording indicator
└── scripts/
    └── get-window-pos.py   # Helper for clipboard popup positioning
```

### Quickshell Patterns

- **PopupButton**: Reusable component for icon buttons with click-to-open popups
  - Full-screen transparent overlay for click-outside-to-close
  - Auto-sizing popup based on content
  - Used by AudioControl and SysTray

- **Audio Control**: Uses `wpctl` (WirePlumber) for PipeWire volume control

- **System Tray**: Uses Quickshell's `SystemTray.items` service
  - Has icon fallbacks for apps with broken icons (e.g., Spotify)

## Key Bindings (niri)

Configured in `.config/niri/config.kdl`. Uses Mod (Super) key as primary modifier.

## Installation

Run `./install.sh` to:
1. Install packages via pacman/yay
2. Symlink config files to ~/.config/
3. Set up zsh with Oh My Zsh

## Audio Control

Uses PipeWire with WirePlumber. Volume commands:
- `wpctl get-volume @DEFAULT_AUDIO_SINK@` - Get speaker volume
- `wpctl set-volume @DEFAULT_AUDIO_SINK@ 0.5` - Set to 50%
- `wpctl get-volume @DEFAULT_AUDIO_SOURCE@` - Get mic volume
