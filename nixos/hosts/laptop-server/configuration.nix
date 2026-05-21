{ config, pkgs, ... }:

{
  imports = [
    ../../modules/server-base.nix
    ./hardware-configuration.nix
  ];

  networking.hostName = "laptop-server";

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  services.xserver.enable = true;
  services.xserver.desktopManager.xfce.enable = true;
  services.xrdp = {
    enable = true;
    defaultWindowManager = "startxfce4";
    openFirewall = false;
  };

  users.users.tobias = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFEvr2qCdxh7peyDqmauJKmLiql3e77uo8+IrkmSwRDe tobias@windows"
    ];
  };

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
