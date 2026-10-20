-- Tobias's Hyprland deltas from Omarchy's defaults. hyprland.lua requires
-- this file last; every other ~/.config/hypr file stays Omarchy's template.

-- LG 4K in portrait on HDMI, Dell S2725QS in landscape beside it.
hl.monitor({ output = "HDMI-A-1", mode = "3840x2160@60", position = "0x-1380", scale = 1.25, transform = 1 })
hl.monitor({ output = "DP-1", mode = "3840x2160@120", position = "1728x-500", scale = 1.25, transform = 0 })

hl.config({
  animations = {
    enabled = false,
  },
})

-- XWayland lists the portrait LG first, so Proton games pick 2160x3840.
-- Marking the Dell primary makes them default to it.
o.exec_on_start("xrandr --output DP-1 --primary")

-- Steam games get workspace 9 on the Dell, fullscreen, so SUPER+9 and
-- SUPER+2 switch between game and desktop without retiling it.
hl.workspace_rule({ workspace = "9", monitor = "DP-1" })
o.window({ class = "^steam_app_[0-9]+$" }, {
  workspace = "9",
  fullscreen = true,
  idle_inhibit = "fullscreen",
})
