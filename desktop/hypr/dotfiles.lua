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
