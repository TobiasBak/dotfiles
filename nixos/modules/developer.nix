{
  hunk,
  pkgs,
  ...
}:

let
  nativeLibraries = with pkgs; [
    expat
    glib
    libGL
    stdenv.cc.cc.lib
    libx11
  ];
  uvWithNativeLibraries = pkgs.symlinkJoin {
    name = "uv-with-native-libraries";
    paths = [ pkgs.uv ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/uv \
        --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath nativeLibraries}"
      wrapProgram $out/bin/uvx \
        --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath nativeLibraries}"
    '';
  };
  vitePlus = pkgs.callPackage ../packages/vite-plus { };
in
{
  imports = [
    ./base.nix
    ./users/tobias.nix
  ];

  programs.zsh.enable = true;
  services.tailscale.enable = true;

  # Supports native PyPI wheels and other dynamically linked development tools.
  programs.nix-ld = {
    enable = true;
    libraries = nativeLibraries;
  };

  environment.sessionVariables.ZSH = "${pkgs.oh-my-zsh}/share/oh-my-zsh";

  home-manager = {
    backupFileExtension = "pre-home-manager";
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
    tailscale
    tmux
    unzip
    uvWithNativeLibraries
    vitePlus
    wget
    xdg-utils
    zsh
    zsh-syntax-highlighting
  ];
}
