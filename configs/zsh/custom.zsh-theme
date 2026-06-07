# Two-line prompt with git status
# Line 1: directory  [arrow  branch][indicators]
# Line 2: →

# Custom RGB colors (24-bit true color via ANSI escapes)
_c_cyan=$'\e[38;2;151;243;249m'    # #97f3f9 - light cyan
_c_pink=$'\e[38;2;255;121;198m'    # #ff79c6 - hot pink
_c_green=$'\e[38;2;72;210;105m'    # #48d269 - soft green
_c_reset=$'\e[0m'

_custom_git_prompt() {
  command git rev-parse --is-inside-work-tree &>/dev/null || return

  local branch
  branch=$(command git symbolic-ref --short HEAD 2>/dev/null) || \
  branch=$(command git describe --tags --exact-match HEAD 2>/dev/null) || \
  branch=$(command git rev-parse --short HEAD 2>/dev/null)
  [[ -z "$branch" ]] && return

  # Nerd Font branch icon
  local branch_icon=$''

  # Ahead/behind upstream
  local arrows=""
  local ahead behind
  ahead=$(command git rev-list --count @{upstream}..HEAD 2>/dev/null)
  behind=$(command git rev-list --count HEAD..@{upstream} 2>/dev/null)
  [[ "${ahead:-0}" -gt 0 ]] && arrows+="⇡"
  [[ "${behind:-0}" -gt 0 ]] && arrows+="⇣"

  local prefix=""
  [[ -n "$arrows" ]] && prefix="${arrows} "

  # Working tree indicators
  local indicators=""
  local status_output
  status_output=$(command git status --porcelain 2>/dev/null)
  [[ -n $(echo "$status_output" | command grep '^??') ]] && indicators+="?"
  [[ -n $(echo "$status_output" | command grep '^ [MD]') ]] && indicators+="!"
  [[ -n $(echo "$status_output" | command grep '^[MADRC]') ]] && indicators+="+"

  local result="%{${_c_pink}%}[${prefix}${branch_icon} ${branch}]"
  [[ -n "$indicators" ]] && result+="[${indicators}]"
  result+="%{${_c_reset}%}"

  echo -n " ${result}"
}

setopt PROMPT_SUBST
PROMPT='%{${_c_cyan}%}%~%{${_c_reset}%}$(_custom_git_prompt)
%{${_c_green}%}→%{${_c_reset}%} '
RPROMPT=''
