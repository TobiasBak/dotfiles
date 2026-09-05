{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  hostname = osConfig.networking.hostName;
  linkFromDotfiles = path: {
    source = config.lib.file.mkOutOfStoreSymlink "${dotfiles}/${path}";
    force = true;
  };
in

{
  home.file = {
    # Niri's generated entry point is the only file here that is not a direct
    # repository link: it selects the portable config and this machine's
    # output layout at evaluation time.
    ".config/niri/config.kdl".text = ''
      include "${dotfiles}/configs/niri/common.kdl"
      include "${dotfiles}/nixos/hosts/${hostname}/niri.kdl"
    '';
    ".config/ghostty/config" = linkFromDotfiles "configs/ghostty/config.ghostty";
    ".config/htop" = linkFromDotfiles "configs/htop";
    ".config/mako" = linkFromDotfiles "configs/mako";
    ".config/quickshell" = linkFromDotfiles "configs/quickshell";
    ".config/Code/User" = linkFromDotfiles "configs/Code/User";
    ".config/systemd/user/t3code.service.d/local.conf" = linkFromDotfiles "configs/t3code/service.conf";

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
