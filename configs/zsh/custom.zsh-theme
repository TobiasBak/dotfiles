# Two-line prompt with git status
# Line 1: directory  [arrow  branch][indicators]
# Line 2: →

# Custom RGB colors (24-bit true color via ANSI escapes)
_c_cyan=$'\e[38;2;151;243;249m'    # #97f3f9 - light cyan
_c_pink=$'\e[38;2;255;121;198m'    # #ff79c6 - hot pink
_c_green=$'\e[38;2;72;210;105m'    # #48d269 - soft green
_c_reset=$'\e[0m'

_custom_git_prompt() {
  local status_output
  status_output=$(command git status --porcelain=v1 --branch 2>/dev/null) || return

  local branch_line="${status_output%%$'\n'*}"
  local branch="${branch_line#\#\# }"
  branch="${branch%%...*}"
  branch="${branch%% \[*}"

  if [[ "$branch" == HEAD* ]]; then
    branch=$(command git rev-parse --short HEAD 2>/dev/null) || return
  fi

  local arrows=""
  [[ "$branch_line" == *"[ahead "* ]] && arrows+="⇡"
  [[ "$branch_line" == *"behind "* ]] && arrows+="⇣"

  local indicators=""
  [[ "$status_output" == *$'\n??'* ]] && indicators+="?"
  [[ "$status_output" == *$'\n '[MD]* ]] && indicators+="!"
  [[ "$status_output" == *$'\n'[MADRC]* ]] && indicators+="+"

  local branch_icon=$''
  local prefix=""
  [[ -n "$arrows" ]] && prefix="${arrows} "

  local result="%{${_c_pink}%}[${prefix}${branch_icon} ${branch}]"
  [[ -n "$indicators" ]] && result+="[${indicators}]"
  result+="%{${_c_reset}%}"

  echo -n " ${result}"
}

setopt PROMPT_SUBST
PROMPT='%{${_c_cyan}%}%~%{${_c_reset}%}$(_custom_git_prompt)
%{${_c_green}%}→%{${_c_reset}%} '
RPROMPT=''
