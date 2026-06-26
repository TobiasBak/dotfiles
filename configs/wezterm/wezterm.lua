local wezterm = require("wezterm")

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
config.window_frame = {
  font = wezterm.font("Hack Nerd Font", { weight = "Bold" }),
}
config.inactive_pane_hsb = {
  saturation = 0.0,
  brightness = 0.5,
}

if is_windows then
  config.win32_system_backdrop = "Acrylic"
  config.window_background_opacity = 0.7
  config.window_frame.font_size = 10.0
  config.default_prog = {
    "wsl.exe",
    "-d",
    "archlinux",
    "--cd",
    "~",
    "--exec",
    "zsh",
    "-lc",
    "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s main; else exec zsh -l; fi",
  }
end

return config
