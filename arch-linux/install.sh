#!/bin/bash

set -e # Exit on error

# --- Configuration ---
DOTFILES_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKUP_DIR="$HOME/dotfiles_backup_$(date +%Y%m%d_%H%M%S)"

# List of packages to install (official repos)
# User: Add or remove packages here
PACKAGES=(
    "zsh"
    "git"
    "github-cli"
    "alacritty"
    "htop"
    "neofetch"
    "quickshell"
    "niri" # Uncomment if niri is in your configured repos, otherwise install via AUR/Cargo separately
    "xwayland-satellite"
    "fuzzel"
    "chromium"
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

check_dependencies() {
    if ! command -v pacman &> /dev/null; then
        echo "Error: This script requires 'pacman'. Are you running Arch Linux?"
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

link_config() {
    local source=$1
    local target=$2

    # Ensure parent directory exists
    mkdir -p "$(dirname "$target")"

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
    link_config "$DOTFILES_DIR/.zshrc" "$HOME/.zshrc"

    # Config folders
    # find all directories inside .config and link them
    for config_dir in "$DOTFILES_DIR/.config"/*; do
        if [ -d "$config_dir" ]; then
            local dirname=$(basename "$config_dir")
            link_config "$config_dir" "$HOME/.config/$dirname"
        fi
    done
}

set_shell() {
    if [ "$SHELL" != "$(which zsh)" ]; then
        log_info "Changing default shell to zsh..."
        chsh -s "$(which zsh)"
        log_success "Shell changed. You may need to log out and back in."
    fi
}

# --- Main Script ---

check_dependencies
install_packages
install_oh_my_zsh
setup_symlinks
set_shell

log_success "Installation complete! \nBackup of old files (if any) is in: $BACKUP_DIR"
