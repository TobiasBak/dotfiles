# Home config for every NixOS desktop workstation.
{ config, pkgs, ... }:

let
  linkFromDotfiles = config.lib.dotfiles.link;
in

{
  imports = [ ./t3code.nix ];

  home.file.".config/htop" = linkFromDotfiles "configs/htop";

  systemd.user.services.taildrop-receiver = {
    Unit = {
      Description = "Receive Tailscale Taildrop files";
      After = [ "network-online.target" ];
    };
    Service = {
      ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p %h/Phone/Inbox";
      ExecStart = "${pkgs.tailscale}/bin/tailscale file get --loop --conflict=rename %h/Phone/Inbox";
      Restart = "on-failure";
      RestartSec = 5;
    };
    Install.WantedBy = [ "default.target" ];
  };
}
