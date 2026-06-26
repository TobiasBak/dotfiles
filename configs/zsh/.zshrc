# If you come from bash you might have to change your $PATH.
export PATH=$HOME/bin:$HOME/.local/bin:/usr/local/bin:$PATH

if [[ -n "${ZSH_TMUX_FAST:-}" ]]; then
  _c_cyan=$'\e[38;2;151;243;249m'
  _c_pink=$'\e[38;2;255;121;198m'
  _c_green=$'\e[38;2;72;210;105m'
  _c_reset=$'\e[0m'

  setopt MENU_COMPLETE
  setopt NO_NOMATCH
  setopt PROMPT_SUBST
  bindkey -M menuselect '^M' .accept-line 2>/dev/null

  alias cy='codex --dangerously-bypass-approvals-and-sandbox'
  if command -v eza >/dev/null 2>&1; then
    alias ls='eza --icons --grid --group-directories-first'
  else
    alias ls='ls --color=auto'
  fi

  # nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  _load_nvm() {
    unfunction node npm npx pnpm pi 2>/dev/null
    source /usr/share/nvm/init-nvm.sh

    local nvm_node
    nvm_node="$(nvm which current 2>/dev/null)"
    if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
      local nvm_bin
      nvm_bin="$(dirname "$nvm_node")"
      path=("$nvm_bin" ${path:#$nvm_bin})
      export PATH
      rehash
    fi
  }

  node() {
    _load_nvm
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
    _load_nvm
    command pnpm "$@"
  }

  pi() {
    _load_nvm
    command pi "$@"
  }

  # pnpm
  export PNPM_HOME="/home/tobias/.local/share/pnpm"
  path=("$PNPM_HOME" ${path:#$PNPM_HOME})
  export PATH

  autoload -Uz compinit
  compinit -C -d "${ZDOTDIR:-$HOME}/.zcompdump-fast-${ZSH_VERSION}"

  if source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null; then
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

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

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

# Codex
alias cy='codex --dangerously-bypass-approvals-and-sandbox'
if command -v eza >/dev/null 2>&1; then
  alias ls='eza --icons --grid --group-directories-first'
else
  alias ls='ls --color=auto'
fi

# nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
_load_nvm() {
  unfunction node npm npx pnpm pi 2>/dev/null
  source /usr/share/nvm/init-nvm.sh

  local nvm_node
  nvm_node="$(nvm which current 2>/dev/null)"
  if [[ -n "$nvm_node" && -x "$nvm_node" ]]; then
    local nvm_bin
    nvm_bin="$(dirname "$nvm_node")"
    path=("$nvm_bin" ${path:#$nvm_bin})
    export PATH
    rehash
  fi
}

node() {
  _load_nvm
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
  _load_nvm
  command pnpm "$@"
}

pi() {
  _load_nvm
  command pi "$@"
}

# Syntax highlighting (must be sourced after Oh My Zsh)
if source /usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh 2>/dev/null; then
  # Highlight styles - commands green (#50fa7b), everything else default white
  ZSH_HIGHLIGHT_STYLES[command]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[builtin]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[alias]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[precommand]='fg=#48d269'
  ZSH_HIGHLIGHT_STYLES[path]='none'
  ZSH_HIGHLIGHT_STYLES[default]='none'
  ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=#ff5555'
fi

# pnpm
export PNPM_HOME="/home/tobias/.local/share/pnpm"
path=("$PNPM_HOME" ${path:#$PNPM_HOME})
export PATH
# pnpm end
