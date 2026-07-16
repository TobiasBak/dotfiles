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
      ".config/hunk/config.toml" = linkFromDotfiles "configs/hunk/config.toml";
      ".npmrc" = linkFromDotfiles "configs/npm/npmrc";

      ".pi/agent/settings.json" = linkFromDotfiles "configs/pi/settings.json";
      ".pi/agent/models.json" = linkFromDotfiles "configs/pi/models.json";
      ".pi/agent/APPEND_SYSTEM.md" = linkFromDotfiles "configs/codex/AGENTS.md";
      ".pi/agent/extensions" = linkFromDotfiles "configs/pi/extensions";
      ".pi/agent/prompts" = linkFromDotfiles "configs/pi/prompts";
      ".pi/agent/keybindings.json" = linkFromDotfiles "configs/pi/keybindings.json";
      ".hypa-pi/config.json" = linkFromDotfiles "configs/pi/hypa.json";

      ".codex/AGENTS.md" = linkFromDotfiles "configs/codex/AGENTS.md";
      ".codex/config.toml" = linkFromDotfiles "configs/codex/config.toml";
      ".codex/prompts" = linkFromDotfiles "configs/codex/prompts";
    };
  };

  programs.git = {
    enable = true;
    settings.user = {
      name = "Tobias Bak";
      email = "tobiasbak@live.dk";
    };
  };
}
