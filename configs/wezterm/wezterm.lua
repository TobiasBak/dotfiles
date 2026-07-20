local wezterm = require("wezterm")
local act = wezterm.action

local config = wezterm.config_builder()

local is_windows = os.getenv("OS") and os.getenv("OS"):lower():find("windows")

if is_windows then
  config.font_dirs = {
    os.getenv("LOCALAPPDATA") .. "\\Microsoft\\Windows\\Fonts",
  }
end

config.color_scheme = "rose-pine-moon"
config.max_fps = 120
config.font = wezterm.font("Hack Nerd Font", { weight = "Regular" })
config.font_size = 11.0
config.hide_tab_bar_if_only_one_tab = true
config.window_decorations = "TITLE|RESIZE"
config.enable_kitty_keyboard = true
config.window_padding = {
  left = 0,
  right = 0,
  top = 0,
  bottom = 0,
}
-- Normalize modified Enter to LF so zsh and Codex insert a newline reliably through WSL/tmux.
config.keys = {
  { key = "Enter", mods = "SHIFT", action = act.SendString("\x0a") },
  { key = "Enter", mods = "CTRL", action = act.SendString("\x0a") },
  { key = "Enter", mods = "CTRL|SHIFT", action = act.SendString("\x0a") },
}
config.window_frame = {
  font = wezterm.font("Hack Nerd Font", { weight = "Bold" }),
}
config.inactive_pane_hsb = {
  saturation = 0.0,
  brightness = 0.5,
}
if is_windows then
  local wsl_startup = [[
shell="$(command -v zsh || command -v bash)"
if [ -z "$shell" ]; then
  echo "No supported login shell found." >&2
  exit 1
fi

export SHELL="$shell"
if command -v tmux >/dev/null 2>&1 && [ -t 0 ]; then
  exec tmux new-session -A -s main
fi

exec "$shell" -l
]]

  config.win32_system_backdrop = "Acrylic"
  config.window_background_opacity = 0.7
  config.window_frame.font_size = 10.0
  config.default_prog = {
    "wsl.exe",
    "-d",
    "NixOS",
    "--cd",
    "~",
    "--exec",
    "bash",
    "-lc",
    wsl_startup,
  }
end

return config
