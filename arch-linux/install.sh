#!/bin/bash

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REAL_REPO_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
STABLE_REPO_DIR="$HOME/.dotfiles"
REPO_DIR="$REAL_REPO_DIR"
CONFIGS_DIR="$REPO_DIR/configs"
BACKUP_DIR="$HOME/dotfiles_backup_$(date +%Y%m%d_%H%M%S)"

# List of packages to install (official repos)
# User: Add or remove packages here
PACKAGES=(
    "zsh"
    "git"
    "github-cli"
    "quickshell"
    "ghostty"
    "wezterm"
    "tmux"
    "htop"
    "eza"
    "niri"
    "xwayland-satellite"
    "wl-clipboard"
    "fuzzel"
    "mako"
    "swaybg"
    "nvm"
    "chromium"
    "discord"
    "base-devel" # Required for building AUR packages
    "ttf-jetbrains-mono-nerd" # Nerd Font for terminal icons
    "ttf-hack-nerd"           # Hack Nerd Font for WezTerm
    "noto-fonts"              # Standard Unicode coverage
    "noto-fonts-cjk"          # Chinese/Japanese/Korean characters
    "noto-fonts-emoji"        # Emoji support (browsers, apps)
    "zsh-syntax-highlighting" # Command syntax highlighting
)

# --- Functions ---

log_info() {
    echo -e "\033[0;34m[INFO]\033[0m $1"
}

log_success() {
    echo -e "\033[0;32m[SUCCESS]\033[0m $1"
}

log_warning() {
    echo -e "\033[0;33m[WARNING]\033[0m $1"
}

ensure_dotfiles_link() {
    if [ -L "$STABLE_REPO_DIR" ] && [ "$(readlink -f "$STABLE_REPO_DIR")" = "$REAL_REPO_DIR" ]; then
        return
    fi

    if [ -e "$STABLE_REPO_DIR" ] && [ ! -L "$STABLE_REPO_DIR" ]; then
        log_warning "$STABLE_REPO_DIR exists and is not a symlink. Config links will use $REAL_REPO_DIR."
        return
    fi

    rm -f "$STABLE_REPO_DIR"
    ln -s "$REAL_REPO_DIR" "$STABLE_REPO_DIR"
    log_success "Linked $STABLE_REPO_DIR -> $REAL_REPO_DIR"
}

repo_dir() {
    if [ -L "$STABLE_REPO_DIR" ] && [ "$(readlink -f "$STABLE_REPO_DIR")" = "$REAL_REPO_DIR" ]; then
        printf '%s\n' "$STABLE_REPO_DIR"
    else
        printf '%s\n' "$REAL_REPO_DIR"
    fi
}

check_dependencies() {
    if ! command -v pacman &> /dev/null; then
        echo "Error: This script requires 'pacman'. Are you running Arch Linux?"
        exit 1
    fi
}

multilib_is_enabled() {
    awk '
        BEGIN { in_multilib = 0; multilib = 0; include = 0 }
        /^[[:space:]]*\[multilib\][[:space:]]*$/ {
            in_multilib = 1
            multilib = 1
            next
        }
        /^[[:space:]]*\[/ {
            in_multilib = 0
        }
        in_multilib && /^[[:space:]]*Include[[:space:]]*=[[:space:]]*\/etc\/pacman\.d\/mirrorlist[[:space:]]*$/ {
            include = 1
        }
        END {
            exit !(multilib && include)
        }
    ' /etc/pacman.conf
}

enable_multilib_repository() {
    local pacman_conf="/etc/pacman.conf"
    local backup_path

    if multilib_is_enabled; then
        log_info "multilib repository already enabled."
        return
    fi

    log_info "Enabling multilib repository..."
    backup_path="${pacman_conf}.bak.$(date +%Y%m%d_%H%M%S)"
    sudo cp "$pacman_conf" "$backup_path"

    if grep -Eq '^[[:space:]]*#\[multilib\][[:space:]]*$' "$pacman_conf"; then
        sudo sed -i \
            '/^[[:space:]]*#\[multilib\][[:space:]]*$/,/^[[:space:]]*#Include[[:space:]]*=[[:space:]]*\/etc\/pacman\.d\/mirrorlist[[:space:]]*$/ s/^[[:space:]]*#//' \
            "$pacman_conf"
    else
        printf '\n[multilib]\nInclude = /etc/pacman.d/mirrorlist\n' | sudo tee -a "$pacman_conf" > /dev/null
    fi

    if multilib_is_enabled; then
        log_success "multilib repository enabled. Backup saved to $backup_path"
    else
        log_warning "Failed to enable multilib repository. Restoring backup from $backup_path"
        sudo cp "$backup_path" "$pacman_conf"
        exit 1
    fi
}

install_packages() {
    log_info "Updating system and installing packages..."
    sudo pacman -Syu --needed --noconfirm "${PACKAGES[@]}"
    log_success "Packages installed."
}


install_oh_my_zsh() {
    if [ ! -d "$HOME/.oh-my-zsh" ]; then
        log_info "Installing Oh My Zsh..."
        sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
        log_success "Oh My Zsh installed."
    else
        log_info "Oh My Zsh already installed."
    fi
}

backup_file() {
    local target=$1
    if [ -e "$target" ] && [ ! -L "$target" ]; then
        mkdir -p "$BACKUP_DIR"
        mv "$target" "$BACKUP_DIR/"
        log_warning "Backed up existing $target to $BACKUP_DIR"
    fi
}

ensure_parent_dir() {
    local target=$1
    local parent
    parent=$(dirname "$target")

    if [ -d "$parent" ]; then
        return
    fi

    if [ -L "$parent" ]; then
        rm "$parent"
        log_warning "Removed stale parent symlink: $parent"
    elif [ -e "$parent" ]; then
        backup_file "$parent"
    fi

    mkdir -p "$parent"
}

link_config() {
    local source=$1
    local target=$2

    ensure_parent_dir "$target"

    # Check if correct link already exists
    if [ -L "$target" ] && [ "$(readlink -f "$target")" == "$source" ]; then
        log_info "Already linked: $target"
        return
    fi

    # Backup existing file/dir if it's not a link
    backup_file "$target"

    # Remove existing link if it points somewhere else
    if [ -L "$target" ]; then
        rm "$target"
    fi

    # Create symlink
    ln -s "$source" "$target"
    log_success "Linked $source -> $target"
}

setup_symlinks() {
    log_info "Setting up symlinks..."

    # Zsh
    link_config "$CONFIGS_DIR/zsh/.zshrc" "$HOME/.zshrc"

    # Custom zsh theme
    mkdir -p "$HOME/.oh-my-zsh/custom/themes"
    link_config "$CONFIGS_DIR/zsh/custom.zsh-theme" "$HOME/.oh-my-zsh/custom/themes/custom.zsh-theme"

    # Pi coding agent
    link_config "$CONFIGS_DIR/pi/settings.json" "$HOME/.pi/agent/settings.json"
    link_config "$CONFIGS_DIR/pi/APPEND_SYSTEM.md" "$HOME/.pi/agent/APPEND_SYSTEM.md"
    link_config "$CONFIGS_DIR/pi/extensions" "$HOME/.pi/agent/extensions"
    link_config "$CONFIGS_DIR/pi/prompts" "$HOME/.pi/agent/prompts"

    # Config folders
    for config_dir in "$CONFIGS_DIR"/*; do
        if [ -d "$config_dir" ]; then
            local dirname=$(basename "$config_dir")

            # Skip configs that are not XDG app config directories on Linux.
            if [ "$dirname" = "zsh" ] || [ "$dirname" = "powershell" ] || [ "$dirname" = "pi" ]; then
                continue
            fi

            # Symlink only the user-managed files for apps that also store runtime data.
            if [ "$dirname" = "Code" ]; then
                mkdir -p "$HOME/.config/Code/User"
                for file in "$config_dir/User"/*; do
                    if [ -f "$file" ]; then
                        link_config "$file" "$HOME/.config/Code/User/$(basename "$file")"
                    fi
                done
            elif [ "$dirname" = "discord" ]; then
                link_config "$config_dir/settings.json" "$HOME/.config/discord/settings.json"
            else
                link_config "$config_dir" "$HOME/.config/$dirname"
            fi
        fi
    done

}

set_shell() {
    local zsh_path
    zsh_path=$(command -v zsh)

    if [ "$SHELL" != "$zsh_path" ]; then
        log_info "Changing default shell to zsh..."
        chsh -s "$zsh_path"
        log_success "Shell changed. You may need to log out and back in."
    fi
}

configure_desktop_settings() {
    log_info "Configuring desktop settings..."
    # Set dark mode via freedesktop color-scheme (used by niri and GTK apps)
    if command -v dconf &> /dev/null; then
        dconf write /org/gnome/desktop/interface/color-scheme "'prefer-dark'"
        log_success "Dark mode enabled."
    else
        log_warning "dconf not found, skipping dark mode setting."
    fi

    # Symlink wallpapers directory
    mkdir -p "$HOME/Pictures"
    link_config "$SCRIPT_DIR/wallpapers" "$HOME/Pictures/Wallpapers"
}

install_node() {
    # Source nvm to make it available in this script
    if [ -f /usr/share/nvm/init-nvm.sh ]; then
        source /usr/share/nvm/init-nvm.sh
        if ! nvm ls --no-colors | grep -q "lts"; then
            log_info "Installing Node.js LTS via nvm..."
            nvm install --lts
            log_success "Node.js LTS installed."
        else
            log_info "Node.js LTS already installed."
        fi
    else
        log_warning "nvm not found, skipping Node.js installation."
    fi
}

install_pi_skills() {
    local skills_repo="https://github.com/TobiasBak/skills.git"
    local skills_dir
    skills_dir="$(cd "$REAL_REPO_DIR/.." && pwd)/skills"
    local target_dir="$HOME/.pi/agent/skills"

    log_info "Installing Pi skills from $skills_dir..."
    mkdir -p "$(dirname "$skills_dir")"
    if [ -d "$skills_dir/.git" ]; then
        git -C "$skills_dir" pull --ff-only
    elif [ ! -e "$skills_dir" ]; then
        rm -rf "$skills_dir"
        git clone "$skills_repo" "$skills_dir"
    else
        log_warning "$skills_dir exists but is not a git repository. Skipping Pi skills."
        return
    fi

    if [ ! -f "$skills_dir/scripts/install-links.sh" ]; then
        log_warning "$skills_dir/scripts/install-links.sh is missing. Skipping Pi skills."
        return
    fi

    rm -rf "$target_dir"
    PI_SKILLS_DIR="$target_dir" bash "$skills_dir/scripts/install-links.sh" --fix
    log_success "Pi skills installed."
}

# --- Main Script ---

ensure_dotfiles_link
REPO_DIR="$(repo_dir)"
CONFIGS_DIR="$REPO_DIR/configs"

check_dependencies
enable_multilib_repository
install_packages
install_oh_my_zsh
install_node
configure_desktop_settings
setup_symlinks
install_pi_skills
set_shell

log_success "Installation complete! \nBackup of old files (if any) is in: $BACKUP_DIR"
