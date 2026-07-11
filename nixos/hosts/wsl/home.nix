{
  config,
  lib,
  ...
}:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  skillsRoot = "${dotfiles}/../skills";
  skillInventory = import ./skills.nix;
  linkFromSource = force: source: {
    source = config.lib.file.mkOutOfStoreSymlink source;
    # The repository is authoritative for every declared home path.
    inherit force;
  };

  dotfileSources = {
    ".zshrc" = "${dotfiles}/configs/zsh/.zshrc";
    ".oh-my-zsh/custom/themes/custom.zsh-theme" = "${dotfiles}/configs/zsh/custom.zsh-theme";
    ".config/tmux" = "${dotfiles}/configs/tmux";
    ".npmrc" = "${dotfiles}/configs/npm/npmrc";

    ".pi/agent/settings.json" = "${dotfiles}/configs/pi/settings.json";
    ".pi/agent/APPEND_SYSTEM.md" = "${dotfiles}/configs/pi/APPEND_SYSTEM.md";
    ".pi/agent/extensions" = "${dotfiles}/configs/pi/extensions";
    ".pi/agent/prompts" = "${dotfiles}/configs/pi/prompts";
    ".pi/agent/keybindings.json" = "${dotfiles}/configs/pi/keybindings.json";

    ".codex/AGENTS.md" = "${dotfiles}/configs/codex/AGENTS.md";
    ".codex/config.toml" = "${dotfiles}/configs/codex/config.toml";
    ".codex/prompts" = "${dotfiles}/configs/codex/prompts";
  };
  dotfileLinks = lib.mapAttrs (_: linkFromSource true) dotfileSources;

  skillSources =
    map (name: {
      inherit name;
      path = "${skillsRoot}/skills/${name}";
    }) skillInventory.personal
    ++ map (name: {
      inherit name;
      path = "${skillsRoot}/external/mattpocock-skills/${name}";
    }) skillInventory.external;
  skillNames = map (skill: skill.name) skillSources;
  skillTargets = [
    ".pi/agent/skills"
    ".agents/skills"
  ];
  skillLinkSources = lib.listToAttrs (
    lib.concatMap (
      skill:
      map (target: {
        name = "${target}/${skill.name}";
        value = skill.path;
      }) skillTargets
    ) skillSources
  );
  skillLinks = lib.mapAttrs (_: linkFromSource false) skillLinkSources;
  managedLinkSources = dotfileSources // skillLinkSources;
  linkManifest =
    lib.concatStringsSep "\n" (
      lib.mapAttrsToList (target: source: "${target}\t${source}") managedLinkSources
    )
    + "\n";
in

{
  home = {
    username = "tobias";
    homeDirectory = "/home/tobias";
    stateVersion = "25.11";

    file =
      dotfileLinks
      // skillLinks
      // {
        ".local/state/dotfiles-wsl-links".text = linkManifest;
      };
  };

  assertions = [
    {
      assertion = lib.length skillNames == lib.length (lib.unique skillNames);
      message = "The pinned skills input contains duplicate skill directory names.";
    }
  ];
}
