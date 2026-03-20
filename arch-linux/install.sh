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
    "quickshell"
    "alacritty"
    "htop"
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

    # Custom zsh theme
    mkdir -p "$HOME/.oh-my-zsh/custom/themes"
    link_config "$DOTFILES_DIR/custom.zsh-theme" "$HOME/.oh-my-zsh/custom/themes/custom.zsh-theme"

    # Config folders
    # find all directories inside .config and link them
    for config_dir in "$DOTFILES_DIR/.config"/*; do
        if [ -d "$config_dir" ]; then
            local dirname=$(basename "$config_dir")
            # VS Code: only symlink individual files, not the whole directory
            # (VS Code stores cache/logs/extensions in .config/Code)
            if [ "$dirname" = "Code" ]; then
                mkdir -p "$HOME/.config/Code/User"
                for file in "$config_dir/User"/*; do
                    if [ -f "$file" ]; then
                        link_config "$file" "$HOME/.config/Code/User/$(basename "$file")"
                    fi
                done
            else
                link_config "$config_dir" "$HOME/.config/$dirname"
            fi
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
    link_config "$DOTFILES_DIR/wallpapers" "$HOME/Pictures/Wallpapers"
}

configure_hardware() {
    log_info "Configuring hardware rules..."
    # Install udev rules for USB autosuspend fix
    if [ -f "$DOTFILES_DIR/99-input-fix.rules" ]; then
        log_info "Installing USB autosuspend fix..."
        sudo cp "$DOTFILES_DIR/99-input-fix.rules" /etc/udev/rules.d/
        # Reload rules
        sudo udevadm control --reload-rules && sudo udevadm trigger
        log_success "USB input fix installed."
    else
        log_warning "99-input-fix.rules not found in dotfiles."
    fi
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

# --- Main Script ---

check_dependencies
install_packages
install_oh_my_zsh
install_node
configure_desktop_settings
configure_hardware
setup_symlinks
set_shell

log_success "Installation complete! \nBackup of old files (if any) is in: $BACKUP_DIR"
