{ ... }:

{
  imports = [
    ../../modules/developer.nix
    ../../modules/desktop-niri.nix
    ./hardware-configuration.nix
  ];

  networking.hostName = "laptop";

  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
  };

  services = {
    power-profiles-daemon.enable = true;
    upower.enable = true;

    logind.settings.Login = {
      HandleLidSwitch = "suspend";
      HandleLidSwitchExternalPower = "suspend";
      HandleLidSwitchDocked = "ignore";
    };
  };

  # Keep this at the release used for the first installation.
  system.stateVersion = "25.11";
}
