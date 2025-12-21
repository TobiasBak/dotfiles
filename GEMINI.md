# GEMINI.md - Project Context

## Directory Overview
This repository is a centralized location for managing dotfiles and system configurations for both **Windows** and **Arch Linux** environments. It allows for consistent system setups across dual-boot or multi-device configurations.

### Key Platforms
- **Arch Linux:** Uses a Wayland-based setup with the `niri` scrollable-tiling window manager, `waybar` for status, and `zsh` as the primary shell.
- **Windows:** Configured via PowerShell setup scripts, intended to automate environment alignment with the user's preferences.

## Key Files and Folders

### Arch Linux (`arch-linux/`)
- `.zshrc`: Shell configuration utilizing **Oh My Zsh** with the `robbyrussell` theme and `git` plugin. Includes custom aliases for VPN and university-related tools.
- `.config/niri/config.kdl`: Configuration for the **Niri** window manager, including Danish keyboard layout, touchpad gestures, and workspace definitions.
- `.config/waybar/`: Status bar configuration using `config.jsonc` and custom shell scripts (`date.sh`, `time.sh`) for data display.
- `.config/alacritty/alacritty.toml`: Terminal configuration using the **TokyoNight** color scheme and `zsh` as the default shell.
- `.config/htop/htoprc`: Configuration for the `htop` system monitor.
- `.config/neofetch/config.conf`: Aesthetic system information display settings.

### Windows (`windows/`)
- `setup.ps1`: A PowerShell script designed to automate the setup process (e.g., symlinking files, installing tools). Currently contains logic to check for Administrator privileges.

### Root Directory
- `README.md`: High-level overview and usage instructions.
- `.env`: Local environment variables (not tracked by Git if sensitive).
- `.gitignore`: Standard Git ignore rules.

## Usage

### Applying Windows Configuration
1. Open PowerShell as Administrator.
2. **Run the Main Setup Script:**
   This script will install applications and set up aliases.
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

### Applying Arch Linux Configuration
1. Ensure `niri`, `waybar`, `alacritty`, and `zsh` are installed.
2. Symlink the contents of `arch-linux/` to your `$HOME` directory:
   - `ln -s ~/dotfiles/arch-linux/.zshrc ~/.zshrc`
   - `ln -s ~/dotfiles/arch-linux/.config/* ~/.config/`
3. Install **Oh My Zsh** for the shell configuration to function correctly.

## Development Conventions
- **Structure:** Keep platform-specific files in their respective folders (`arch-linux/` or `windows/`).
- **Scripts:** Use PowerShell (`.ps1`) for Windows automation and Shell scripts (`.sh`) for Linux automation.
- **Privacy:** Do not commit sensitive information; use the root `.env` file for such data.
