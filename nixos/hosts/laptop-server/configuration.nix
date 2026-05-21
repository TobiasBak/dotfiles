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
      # Replace this with your real public key before relying on remote SSH.
      "ssh-ed25519 REPLACE_WITH_YOUR_PUBLIC_KEY tobias"
    ];
  };

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
