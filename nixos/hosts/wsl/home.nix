{ config, ... }:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  linkFromDotfiles = path: {
    source = config.lib.file.mkOutOfStoreSymlink "${dotfiles}/${path}";
    # The repository is authoritative for every declared home path.
    force = true;
  };
in

{
  home = {
    username = "tobias";
    homeDirectory = "/home/tobias";
    stateVersion = "25.11";

    file = {
      ".zshrc" = linkFromDotfiles "configs/zsh/.zshrc";
      ".oh-my-zsh/custom/themes/custom.zsh-theme" = linkFromDotfiles "configs/zsh/custom.zsh-theme";
      ".config/tmux" = linkFromDotfiles "configs/tmux";
      ".npmrc" = linkFromDotfiles "configs/npm/npmrc";

      ".pi/agent/settings.json" = linkFromDotfiles "configs/pi/settings.json";
      ".pi/agent/APPEND_SYSTEM.md" = linkFromDotfiles "configs/pi/APPEND_SYSTEM.md";
      ".pi/agent/extensions" = linkFromDotfiles "configs/pi/extensions";
      ".pi/agent/prompts" = linkFromDotfiles "configs/pi/prompts";
      ".pi/agent/keybindings.json" = linkFromDotfiles "configs/pi/keybindings.json";

      ".codex/AGENTS.md" = linkFromDotfiles "configs/codex/AGENTS.md";
      ".codex/config.toml" = linkFromDotfiles "configs/codex/config.toml";
      ".codex/prompts" = linkFromDotfiles "configs/codex/prompts";
    };
  };
}
