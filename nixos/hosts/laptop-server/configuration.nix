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
  services.xserver.displayManager.lightdm.enable = true;
  services.xserver.xkb.layout = "dk";
  services.xserver.desktopManager.xfce.enable = true;
  services.xrdp = {
    enable = true;
    defaultWindowManager = "xfce4-session";
    openFirewall = true;
  };

  services.samba = {
    enable = true;
    openFirewall = true;
    settings = {
      global = {
        "server string" = "laptop-server";
        "workgroup" = "WORKGROUP";
        "security" = "user";
        "map to guest" = "Never";
        "invalid users" = [ "root" ];
        "hosts allow" = "100.64.0.0/10 192.168.86.0/24 127.0.0.1";
        "hosts deny" = "0.0.0.0/0";
        "smb encrypt" = "required";
      };
      nas = {
        "path" = "/srv/nas";
        "browseable" = "yes";
        "read only" = "no";
        "valid users" = [ "tobias" ];
        "force user" = "tobias";
        "create mask" = "0644";
        "directory mask" = "0755";
      };
    };
  };

  services.samba-wsdd = {
    enable = true;
    openFirewall = true;
  };

  networking.firewall.allowedTCPPorts = [ 22 3389 ];
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 445 3389 ];

  systemd.tmpfiles.rules = [
    "d /srv/nas 0755 tobias users -"
  ];

  console.keyMap = "dk-latin1";

  users.users.tobias = {
    isNormalUser = true;
    description = "tobias";
    extraGroups = [ "wheel" "networkmanager" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFEvr2qCdxh7peyDqmauJKmLiql3e77uo8+IrkmSwRDe tobias@windows"
    ];
  };

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
