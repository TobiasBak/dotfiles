{ pkgs, ... }:

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
  };

  environment.systemPackages = with pkgs; [
    bat
    cacert
    codex
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
    openssh
    pnpm
    python3
    ripgrep
    tmux
    unzip
    vim
    wslu
    xdg-utils
    zsh
    zsh-syntax-highlighting
  ];

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
