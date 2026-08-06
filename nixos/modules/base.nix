{ pkgs, ... }:

{
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  time.timeZone = "Europe/Copenhagen";

  services.openssh.settings.PasswordAuthentication = true;

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  nix.optimise = {
    automatic = true;
    dates = [ "weekly" ];
  };

  environment.systemPackages = with pkgs; [
    btop
    curl
    git
    jq
    ripgrep
    vim
  ];
}
