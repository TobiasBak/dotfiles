{ config, pkgs, ... }:

{
  imports = [
    ../../modules/server-base.nix
    ./hardware-configuration.nix
  ];

  networking.hostName = "tobias-serv01";

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  virtualisation.docker.enable = true;

  environment.systemPackages = with pkgs; [
    docker-compose
  ];

  services.samba = {
    enable = true;
    openFirewall = true;
    settings = {
      global = {
        "server string" = "tobias-serv01";
        "workgroup" = "WORKGROUP";
        "security" = "user";
        "map to guest" = "Never";
        "invalid users" = [ "root" ];
        "hosts allow" = "100.64.0.0/10 192.168.86.0/24 127.0.0.1";
        "hosts deny" = "0.0.0.0/0";
        "smb encrypt" = "required";
      };
      nas = {
        "path" = "/srv/nas/files";
        "browseable" = "yes";
        "read only" = "no";
        "valid users" = [ "tobias" ];
        "force user" = "tobias";
        "create mask" = "0644";
        "directory mask" = "0755";
        # Windows clients need execute access to launch .bat/.exe files from SMB,
        # even though the NAS stores normal files without Unix execute bits.
        "acl allow execute always" = "yes";
      };
    };
  };

  services.samba-wsdd = {
    enable = true;
    openFirewall = true;
  };

  fileSystems."/srv/nas" = {
    device = "/dev/disk/by-uuid/fc63f569-7356-4020-a715-efce9b3ef742";
    fsType = "ext4";
  };

  systemd.services.samba-smbd = {
    requires = [ "srv-nas.mount" "nas-directory-permissions.service" ];
    after = [ "srv-nas.mount" "nas-directory-permissions.service" ];
    unitConfig = {
      AssertPathIsMountPoint = "/srv/nas";
      AssertPathIsDirectory = "/srv/nas/files";
    };
  };

  systemd.services.nas-directory-permissions = {
    description = "Set NAS directory ownership";
    requires = [ "srv-nas.mount" ];
    after = [ "srv-nas.mount" ];
    before = [ "samba-smbd.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${pkgs.coreutils}/bin/mkdir -p /srv/nas/files
      ${pkgs.coreutils}/bin/chown tobias:users /srv/nas
      ${pkgs.coreutils}/bin/chown tobias:users /srv/nas/files
      ${pkgs.coreutils}/bin/chmod 0755 /srv/nas
      ${pkgs.coreutils}/bin/chmod 0755 /srv/nas/files
    '';
  };

  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 445 ];

  systemd.tmpfiles.rules = [
    "d /srv/nas 0755 tobias users -"
  ];

  console.keyMap = "dk-latin1";

  users.users.tobias = {
    isNormalUser = true;
    description = "tobias";
    extraGroups = [ "wheel" "networkmanager" "docker" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFEvr2qCdxh7peyDqmauJKmLiql3e77uo8+IrkmSwRDe tobias@windows"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPwf+bDRHxfll2vHjpPt33kQyFacdcr/wuXqJvUVKNx+ tobias@DESKTOP-LOEC6VP"
    ];
  };

  security.sudo.extraRules = [
    {
      users = [ "tobias" ];
      commands = [
        {
          command = "/run/current-system/sw/bin/nixos-rebuild switch --flake /home/tobias/code/dotfiles/nixos";
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
