{
  pkgs,
  ...
}:

let
  codexCli = pkgs.callPackage ../../packages/codex-cli { };
  piCodingAgent = pkgs.callPackage ../../packages/pi-coding-agent { };
  vitePlus = pkgs.callPackage ../../packages/vite-plus { };

  windowsCode = pkgs.writeShellScriptBin "code" ''
    for candidate in \
      "/mnt/c/Users/''${USER}/AppData/Local/Programs/Microsoft VS Code/bin/code" \
      "/mnt/c/Users/tobias/AppData/Local/Programs/Microsoft VS Code/bin/code" \
      "/mnt/c/Program Files/Microsoft VS Code/bin/code"
    do
      if [ -x "$candidate" ]; then
        exec "$candidate" "$@"
      fi
    done

    echo "code: Windows VS Code CLI not found." >&2
    exit 127
  '';
in

{
  wsl = {
    enable = true;
    defaultUser = "tobias";
    startMenuLaunchers = true;
    useWindowsDriver = true;
    wslConf.interop.appendWindowsPath = false;
  };

  networking.hostName = "nixos-wsl";
  time.timeZone = "Europe/Copenhagen";

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  nix.optimise = {
    automatic = true;
    dates = [ "weekly" ];
  };

  programs.zsh.enable = true;
  programs.nix-ld.enable = true;
  programs.nix-ld.libraries = with pkgs; [
    expat
    glib
    libGL
    stdenv.cc.cc.lib
    xorg.libX11
  ];
  services.tailscale.enable = true;

  users.users.tobias = {
    isNormalUser = true;
    description = "tobias";
    home = "/home/tobias";
    shell = pkgs.zsh;
    extraGroups = [ "wheel" ];
  };

  # WSL setup is driven from Windows automation, so first rebuilds must not
  # depend on an interactive password prompt.
  security.sudo.wheelNeedsPassword = false;

  environment.sessionVariables = {
    BROWSER = "wslview";
    GH_BROWSER = "wslview";
    ZSH = "${pkgs.oh-my-zsh}/share/oh-my-zsh";
    # Let uv-managed PyPI native wheels find nix-ld runtime libraries.
    LD_LIBRARY_PATH = "/run/current-system/sw/share/nix-ld/lib";
  };

  environment.etc."dotfiles-nixos-wsl-system-ok".text = ''
    This NixOS WSL system is managed by the dotfiles flake.
  '';

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.tobias = import ./home.nix;
  };

  environment.systemPackages = with pkgs; [
    bat
    cacert
    codexCli
    coreutils
    curl
    eza
    fd
    git
    gh
    jq
    nixd
    nixfmt-rfc-style
    nodejs
    oh-my-zsh
    openssl
    openssh
    pnpm
    piCodingAgent
    python3
    ripgrep
    tailscale
    tmux
    unzip
    uv
    vitePlus
    vim
    wget
    windowsCode
    wslu
    xdg-utils
    zsh
    zsh-syntax-highlighting
  ];

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
