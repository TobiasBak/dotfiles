{ pkgs, ... }:

{
  imports = [ ./base.nix ];

  networking.networkmanager.enable = true;

  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
      KbdInteractiveAuthentication = false;
    };
  };

  services.tailscale.enable = true;

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

  systemd.sleep.extraConfig = ''
    AllowSuspend=no
    AllowHibernation=no
    AllowHybridSleep=no
    AllowSuspendThenHibernate=no
  '';

  environment.systemPackages = with pkgs; [
    btop
    htop
    tailscale
  ];
}
