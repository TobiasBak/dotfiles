# If you come from bash you might have to change your $PATH.
export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

_is_wsl_shell() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null
}

_remove_wsl_windows_path() {
  local -a filtered_path
  local entry
  filtered_path=()

  for entry in "${path[@]}"; do
    [[ "${entry[1,5]}" == "/mnt/" ]] && continue
    filtered_path+=("$entry")
  done

  path=("${filtered_path[@]}")
  export PATH
  rehash 2>/dev/null || true
}

if _is_wsl_shell; then
  _remove_wsl_windows_path

  # Repair stale tmux/session environments after NixOS rebuilds. Old sessions
  # can keep __NIXOS_SET_ENVIRONMENT_DONE without the current nix-ld library path.
  _nix_ld_lib_path="${NIX_LD_LIBRARY_PATH:-/run/current-system/sw/share/nix-ld/lib}"
  if [[ -r "$_nix_ld_lib_path/libstdc++.so.6" ]]; then
    case ":${LD_LIBRARY_PATH:-}:" in
      *":$_nix_ld_lib_path:"*) ;;
      *) export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}$_nix_ld_lib_path" ;;
    esac
  fi
  unset _nix_ld_lib_path
fi

# Match WezTerm's modified-Enter LF fallback with multiline shell editing.
_insert_editor_newline() {
  LBUFFER+=$'\n'
}
zle -N _insert_editor_newline

_bind_modified_enter_keys() {
  local keymap
  for keymap in emacs viins; do
    bindkey -M "$keymap" '^J' _insert_editor_newline 2>/dev/null
    bindkey -M "$keymap" $'\e[13;2u' _insert_editor_newline 2>/dev/null
    bindkey -M "$keymap" $'\e[13;5u' _insert_editor_newline 2>/dev/null
    bindkey -M "$keymap" $'\e[13;6u' _insert_editor_newline 2>/dev/null
  done
}

_bind_word_navigation_keys() {
  local keymap
  for keymap in emacs viins; do
    bindkey -M "$keymap" $'\e[1;5D' backward-word 2>/dev/null
    bindkey -M "$keymap" $'\e[1;5C' forward-word 2>/dev/null
  done
}

finder() {
  local target="${1:-.}"

  if ! _is_wsl_shell; then
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$target"
      return
    fi

    print -u2 "finder could not find xdg-open."
    return 1
  fi

  local windows_path
  local wslpath_bin
  wslpath_bin="$(command -v wslpath 2>/dev/null || true)"
  if [[ -z "$wslpath_bin" && -x /bin/wslpath ]]; then
    wslpath_bin=/bin/wslpath
  elif [[ -z "$wslpath_bin" && -x /sbin/wslpath ]]; then
    wslpath_bin=/sbin/wslpath
  fi

  if [[ -z "$wslpath_bin" ]]; then
    print -u2 "finder could not find wslpath."
    return 1
  fi

  windows_path="$("$wslpath_bin" -w "$target")" || return

  if command -v explorer.exe >/dev/null 2>&1; then
    explorer.exe "$windows_path"
  elif [[ -x /mnt/c/Windows/explorer.exe ]]; then
    /mnt/c/Windows/explorer.exe "$windows_path"
  else
    print -u2 "finder could not find Windows Explorer."
    return 1
  fi
}

_codex_path_is_windows() {
  [[ "${1[1,5]}" == "/mnt/" ]]
}

unalias cy 2>/dev/null
cy() {
  local codex_path
  codex_path="$(command -v codex 2>/dev/null || true)"

  if [[ -z "$codex_path" ]]; then
    print -u2 "codex CLI is not installed for this Linux environment. Run ~/.dotfiles/scripts/bootstrap-developer-tools.sh."
    return 127
  fi

  if _codex_path_is_windows "$codex_path"; then
    print -u2 "Refusing to run Windows Codex from WSL: $codex_path"
    print -u2 "Run ~/.dotfiles/scripts/bootstrap-developer-tools.sh to install native Linux Codex."
    return 127
  fi

  command codex --dangerously-bypass-approvals-and-sandbox "$@"
}

# Lazy-load Node tooling once. Keep npm and npx as permanent policy wrappers;
# removing them during initialization would unblock every call after the first.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
_load_nvm() {
  [[ -n "${_NVM_LAZY_LOADED:-}" ]] && return 0

  unfunction node pnpm pi 2>/dev/null
  if [[ -r /usr/share/nvm/init-nvm.sh ]]; then
    source /usr/share/nvm/init-nvm.sh
  elif [[ -r "$NVM_DIR/nvm.sh" ]]; then
    source "$NVM_DIR/nvm.sh"
  elif command -v node >/dev/null 2>&1; then
    typeset -g _NVM_LAZY_LOADED=1
    rehash
    return 0
  else
    print -u2 "nvm init script not found and no system node is available."
    return 1
  fi

  local nvm_node
  nvm_node="$(nvm which current 2>/dev/null)"
  if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
    local nvm_bin
    nvm_bin="$(dirname "$nvm_node")"
    path=("$nvm_bin" ${path:#$nvm_bin})
    export PATH
    rehash
  fi
  typeset -g _NVM_LAZY_LOADED=1
}

node() {
  _load_nvm || return
  command node "$@"
}

npm() {
  _load_nvm
  print -u2 "npm is blocked in this shell. Use pnpm instead."
  print -u2 "If you really need npm once, run: command npm $*"
  return 1
}

npx() {
  _load_nvm
  print -u2 "npx is blocked in this shell. Use pnpm dlx instead."
  print -u2 "If you really need npx once, run: command npx $*"
  return 1
}

pnpm() {
  _load_nvm || return
  command pnpm "$@"
}

pi() {
  _load_nvm || return
  command pi "$@"
}

alias t3token='command npx --yes t3@nightly auth pairing create'

export PNPM_HOME="$HOME/.local/share/pnpm"
export PNPM_BIN="$PNPM_HOME/bin"
path=("$PNPM_BIN" ${path:#$PNPM_BIN})
export PATH

if [[ -n "${ZSH_TMUX_FAST:-}" ]]; then
  _c_cyan=$'\e[38;2;151;243;249m'
  _c_pink=$'\e[38;2;255;121;198m'
  _c_green=$'\e[38;2;72;210;105m'
  _c_reset=$'\e[0m'

  setopt MENU_COMPLETE
  setopt NO_NOMATCH
  setopt PROMPT_SUBST
  bindkey -M menuselect '^M' .accept-line 2>/dev/null
  _bind_modified_enter_keys
  _bind_word_navigation_keys

  if command -v eza >/dev/null 2>&1; then
    alias ls='eza --icons --grid --group-directories-first'
  else
    alias ls='ls --color=auto'
  fi

  autoload -Uz compinit
  compinit -C -d "${ZDOTDIR:-$HOME}/.zcompdump-fast-${ZSH_VERSION}"

  if source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null ||
     source /run/current-system/sw/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null ||
     source "$HOME/.nix-profile/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" 2>/dev/null; then
    ZSH_HIGHLIGHT_STYLES[command]='fg=#48d269'
    ZSH_HIGHLIGHT_STYLES[builtin]='fg=#48d269'
    ZSH_HIGHLIGHT_STYLES[alias]='fg=#48d269'
    ZSH_HIGHLIGHT_STYLES[precommand]='fg=#48d269'
    ZSH_HIGHLIGHT_STYLES[path]='none'
    ZSH_HIGHLIGHT_STYLES[default]='none'
    ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=#ff5555'
  fi

  _custom_git_prompt_fast() {
    local branch
    branch=$(command git symbolic-ref --quiet --short HEAD 2>/dev/null) \
      || branch=$(command git rev-parse --short HEAD 2>/dev/null) \
      || return

    local branch_icon=$''
    echo -n " %{${_c_pink}%}[${branch_icon} ${branch}]%{${_c_reset}%}"
  }

  PROMPT='%{${_c_cyan}%}%~%{${_c_reset}%}$(_custom_git_prompt_fast)
%{${_c_green}%}→%{${_c_reset}%} '
  RPROMPT=''
  return
fi

# NixOS supplies ZSH through the session environment. Other installers keep
# using the traditional per-user Oh My Zsh location.
export ZSH="${ZSH:-$HOME/.oh-my-zsh}"
export ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time Oh My Zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="custom"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME=random will cause zsh to load
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(git)

source $ZSH/oh-my-zsh.sh

# Tab completion: immediately select first match and accept+execute on Enter
setopt MENU_COMPLETE
setopt NO_NOMATCH
bindkey -M menuselect '^M' .accept-line
_bind_modified_enter_keys
_bind_word_navigation_keys

# User configuration

# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='nvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch $(uname -m)"

# Set personal aliases, overriding those provided by Oh My Zsh libs,
# plugins, and themes. Aliases can be placed here, though Oh My Zsh
# users are encouraged to define aliases within a top-level file in
# the $ZSH_CUSTOM folder, with .zsh extension. Examples:
# - $ZSH_CUSTOM/aliases.zsh
# - $ZSH_CUSTOM/macos.zsh
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"

if command -v eza >/dev/null 2>&1; then
  alias ls='eza --icons --grid --group-directories-first'
else
  alias ls='ls --color=auto'
fi

# Syntax highlighting (must be sourced after Oh My Zsh)
if source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null ||
   source /run/current-system/sw/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null ||
   source "$HOME/.nix-profile/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" 2>/dev/null; then
  # Highlight styles - commands green (#50fa7b), everything else default white
  ZSH_HIGHLIGHT_STYLES[command]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[builtin]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[alias]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[precommand]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[path]='none'
  ZSH_HIGHLIGHT_STYLES[default]='none'
  ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=#ff5555'
fi
