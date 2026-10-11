{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:

let
  home = config.home.homeDirectory;
  dotfiles = "${home}/.dotfiles";
  hostname = osConfig.networking.hostName;
  linkFromDotfiles = config.lib.dotfiles.link;
in

{
  imports = [ ./workstation.nix ];

  home.file = {
    # Select the portable Niri config and this machine's output layout.
    ".config/niri/config.kdl".text = ''
      include "${dotfiles}/configs/niri/common.kdl"
      include "${dotfiles}/nixos/hosts/${hostname}/niri.kdl"
    '';
    ".config/ghostty/config" = linkFromDotfiles "configs/ghostty/config.ghostty";
    ".config/mako" = linkFromDotfiles "configs/mako";
    ".config/quickshell" = linkFromDotfiles "configs/quickshell";
    ".config/Code/User" = linkFromDotfiles "configs/Code/User";

    "Pictures/Wallpapers" = linkFromDotfiles "assets/wallpapers";
  };

  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "text/html" = [ "chromium-browser.desktop" ];
      "application/xhtml+xml" = [ "chromium-browser.desktop" ];
      "x-scheme-handler/http" = [ "chromium-browser.desktop" ];
      "x-scheme-handler/https" = [ "chromium-browser.desktop" ];
    };
  };

  systemd.user.services.stremio-server = lib.mkIf (hostname == "pc") {
    Unit.Description = "Stremio streaming and transcoding for the browser";
    Service = {
      ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p %h/.local/share/stremio-server";
      ExecStart = "${pkgs.nodejs}/bin/node ${pkgs.stremio-linux-shell}/libexec/stremio/server.js";
      Environment = [
        "APP_PATH=%h/.local/share/stremio-server"
        "FFMPEG_BIN=${pkgs.ffmpeg}/bin/ffmpeg"
        "FFPROBE_BIN=${pkgs.ffmpeg}/bin/ffprobe"
      ];
      Restart = "on-failure";
      RestartSec = 5;
    };
    Install.WantedBy = [ "default.target" ];
  };

  systemd.user.services.nas-mount = lib.mkIf (hostname == "pc") {
    Unit = {
      Description = "Mount the NAS over SSHFS";
      After = [ "network-online.target" ];
      Wants = [ "network-online.target" ];
    };
    Service = {
      Type = "simple";
      ExecStartPre = [
        "${pkgs.coreutils}/bin/mkdir -p %h/nas"
        "-/run/wrappers/bin/fusermount3 -uz %h/nas"
      ];
      ExecStart = ''
        ${pkgs.sshfs}/bin/sshfs -f \
          -o BatchMode=yes \
          -o IdentityFile=%h/.ssh/id_ed25519 \
          -o IdentitiesOnly=yes \
          -o StrictHostKeyChecking=yes \
          -o reconnect \
          -o ServerAliveInterval=15 \
          -o ServerAliveCountMax=3 \
          tobias-serv01:/srv/nas/files %h/nas
      '';
      ExecStop = "/run/wrappers/bin/fusermount3 -uz %h/nas";
      Restart = "on-failure";
      RestartSec = 10;
    };
    Install.WantedBy = [ "default.target" ];
  };

  dconf.settings."org/gnome/desktop/interface".color-scheme = "prefer-dark";
}
