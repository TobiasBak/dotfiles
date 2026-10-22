{ pkgs, ... }:

{
  imports = [ ./base.nix ];

  networking.networkmanager.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "no";
      KbdInteractiveAuthentication = false;
    };
  };

  services.tailscale = {
    enable = true;
    package = pkgs.callPackage ../packages/tailscale.nix { };
  };

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 ];
    checkReversePath = "loose";
  };

  security.sudo.wheelNeedsPassword = true;

  services.logind.settings.Login = {
    HandleLidSwitch = "ignore";
    HandleLidSwitchExternalPower = "ignore";
    HandleLidSwitchDocked = "ignore";
  };

  systemd.sleep.settings.Sleep = {
    AllowSuspend = false;
    AllowHibernation = false;
    AllowHybridSleep = false;
    AllowSuspendThenHibernate = false;
  };

  environment.systemPackages = with pkgs; [ htop ];
}
