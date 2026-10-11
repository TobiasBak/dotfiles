{
  hunk,
  pkgs,
  ...
}:

let
  developerCli = import ../packages/developer-cli.nix { inherit hunk pkgs; };
in
{
  imports = [
    ./base.nix
    ./users/tobias.nix
  ];

  programs.zsh.enable = true;
  # Both Oh My Zsh and the fast tmux shell initialize completion in .zshrc.
  # Keep completion files available without running compinit twice per shell.
  programs.zsh.enableGlobalCompInit = false;
  services.tailscale.enable = true;

  # Supports native PyPI wheels and other dynamically linked development tools.
  programs.nix-ld = {
    enable = true;
    libraries = developerCli.nativeLibraries;
  };

  environment.sessionVariables.ZSH = "${pkgs.oh-my-zsh}/share/oh-my-zsh";

  home-manager = {
    backupFileExtension = "pre-home-manager";
    useGlobalPkgs = true;
    useUserPackages = true;
    users.tobias.imports = [ ../home/tobias/common.nix ];
  };

  environment.systemPackages =
    developerCli.portable
    ++ (with pkgs; [
      cacert
      coreutils
      developerCli.chromium
      openssh
      tailscale
      developerCli.uvWithNativeLibraries
      xdg-utils
      zsh
    ]);
}
