{
  hunk,
  pkgs,
  ...
}:

let
  vitePlus = pkgs.callPackage ../packages/vite-plus { };
in
{
  imports = [
    ./base.nix
    ./users/tobias.nix
  ];

  programs.zsh.enable = true;

  # Supports native PyPI wheels and other dynamically linked development tools.
  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      expat
      glib
      libGL
      stdenv.cc.cc.lib
      libx11
    ];
  };

  environment.sessionVariables.ZSH = "${pkgs.oh-my-zsh}/share/oh-my-zsh";

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.tobias.imports = [ ../home/tobias/common.nix ];
  };

  environment.systemPackages = with pkgs; [
    bat
    cacert
    coreutils
    chromium
    eza
    fd
    gh
    hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk
    nixd
    nixfmt
    nodejs
    oh-my-zsh
    openssl
    openssh
    pnpm
    python3
    tmux
    unzip
    uv
    vitePlus
    wget
    xdg-utils
    zsh
    zsh-syntax-highlighting
  ];
}
