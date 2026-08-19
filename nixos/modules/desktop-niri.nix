{
  config,
  pkgs,
  ...
}:

let
  codexbar = pkgs.callPackage ../packages/codexbar { };
  codexCli = pkgs.writeShellScriptBin "codex" ''
    exec "$HOME/.local/share/pnpm/bin/codex" "$@"
  '';

  mkNiriService = description: execStart: {
    inherit description;
    wantedBy = [ "niri.service" ];
    partOf = [ "niri.service" ];
    after = [ "niri.service" ];
    serviceConfig = {
      ExecStart = execStart;
      Restart = "on-failure";
    };
  };
in
{
  networking.networkmanager.enable = true;

  boot.loader = {
    efi = {
      canTouchEfiVariables = true;
      efiSysMountPoint = "/boot/efi";
    };
    grub = {
      enable = true;
      device = "nodev";
      efiSupport = true;
      useOSProber = true;
    };
  };

  hardware.enableRedistributableFirmware = true;
  hardware.graphics.enable = true;
  security.rtkit.enable = true;
  security.polkit.enable = true;
  security.pam.services = {
    greetd.enableGnomeKeyring = true;
    swaylock = { };
  };

  services = {
    tailscale.extraSetFlags = [ "--operator=tobias" ];

    greetd = {
      enable = true;
      settings.default_session = {
        command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --cmd ${config.programs.niri.package}/bin/niri-session";
        user = "greeter";
      };
    };

    pipewire = {
      enable = true;
      alsa.enable = true;
      pulse.enable = true;
      wireplumber.enable = true;
    };

    openssh = {
      enable = true;
      openFirewall = true;
      settings = {
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "no";
      };
    };

    gvfs.enable = true;
    udisks2.enable = true;
    fwupd.enable = true;
    fstrim.enable = true;
  };

  programs = {
    dconf.enable = true;
    niri.enable = true;
  };

  virtualisation.docker.enable = true;
  users.users.tobias = {
    extraGroups = [
      "docker"
      "networkmanager"
      "video"
    ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDcfYHFOxRxSQzxA9AixpvoJTW5xF16LVvIgkkBiEl5F tobias-nixos-wsl"
    ];
  };

  console.keyMap = "dk-latin1";

  environment.sessionVariables = {
    GTK_IM_MODULE = "simple";
    NIXOS_OZONE_WL = "1";
  };

  nixpkgs.config.allowUnfree = true;

  fonts.packages = with pkgs; [
    hack-font
    jetbrains-mono
    nerd-fonts.hack
    nerd-fonts.jetbrains-mono
    noto-fonts
    noto-fonts-cjk-sans
    noto-fonts-cjk-serif
    noto-fonts-color-emoji
  ];

  environment.systemPackages = with pkgs; [
    adwaita-icon-theme
    brave
    brightnessctl
    codexbar
    docker-compose
    fuzzel
    ghostty
    htop
    libnotify
    mako
    nautilus
    networkmanagerapplet
    papirus-icon-theme
    pavucontrol
    pciutils
    playerctl
    quickshell
    swaybg
    swaylock
    vscode
    wayland-utils
    wireplumber
    wl-clipboard
    xwayland-satellite
  ];

  systemd.user.services = {
    # Let niri-session provide the complete user PATH, including system and
    # Home Manager packages used by Niri key bindings.
    niri.enableDefaultPath = false;

    # A lingering user manager can D-Bus-activate the portal outside a session.
    # Tie it to Niri so every portal process gets the current Wayland variables.
    xdg-desktop-portal = {
      after = [ "niri.service" ];
      partOf = [ "niri.service" ];
      requisite = [ "niri.service" ];
    };

    quickshell = (mkNiriService "Quickshell desktop shell" "${pkgs.quickshell}/bin/quickshell") // {
      path = [
        config.programs.niri.package
        pkgs.bash
        codexCli
        codexbar
        pkgs.nodejs
        pkgs.python3
        pkgs.wireplumber
        pkgs.wl-clipboard
      ];
    };
    mako = mkNiriService "Mako notification daemon" "${pkgs.mako}/bin/mako";
    swaybg = mkNiriService "Desktop wallpaper" "${pkgs.swaybg}/bin/swaybg -i %h/Pictures/Wallpapers/wallpaper.jpg -m fill";
    polkit-gnome-authentication-agent = mkNiriService "Polkit authentication agent" "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
  };

  home-manager.users.tobias.imports = [ ../home/tobias/desktop.nix ];
}
