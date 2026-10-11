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
  linkFromDotfiles = path: {
    source = config.lib.file.mkOutOfStoreSymlink "${dotfiles}/${path}";
    force = true;
  };
in

{
  imports = [ ./t3code.nix ];

  home.file = {
    # Select the portable Niri config and this machine's output layout.
    ".config/niri/config.kdl".text = ''
      include "${dotfiles}/configs/niri/common.kdl"
      include "${dotfiles}/nixos/hosts/${hostname}/niri.kdl"
    '';
    ".config/ghostty/config" = linkFromDotfiles "configs/ghostty/config.ghostty";
    ".config/htop" = linkFromDotfiles "configs/htop";
    ".config/mako" = linkFromDotfiles "configs/mako";
    ".config/quickshell" = linkFromDotfiles "configs/quickshell";
    ".config/Code/User" = linkFromDotfiles "configs/Code/User";
    ".local/bin/restic-t3" = lib.mkIf (hostname == "pc") {
      source = "${config.home.path}/bin/restic-t3";
    };

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

  services.restic = lib.mkIf (hostname == "pc") {
    enable = true;
    backups.t3 = {
      repository = "sftp:tobias@tobias-serv01:/srv/nas/files/.backups/t3-pc";
      passwordFile = "${home}/.config/restic/t3-password";
      initialize = true;
      paths = [
        "${home}/.local/state/t3-backup"
        "${home}/.t3/userdata"
        "${home}/.pi/agent"
      ];
      exclude = [
        "${home}/.t3/userdata/state*.sqlite*"
        "${home}/.t3/userdata/logs"
        "${home}/.t3/userdata/usage-*cache*.json"
        "${home}/.t3/userdata/model-manifest.json"
        "${home}/.pi/agent/bin"
      ];
      backupPrepareCommand = ''
        set -euo pipefail
        ${pkgs.coreutils}/bin/install -d -m 0700 "${home}/.local/state/t3-backup"
        ${pkgs.sqlite}/bin/sqlite3 -readonly "${home}/.t3/userdata/statev2.sqlite" \
          ".backup '${home}/.local/state/t3-backup/statev2.sqlite'"
        ${pkgs.coreutils}/bin/cp -L "${home}/.pi/agent/settings.json" \
          "${home}/.local/state/t3-backup/pi-settings.json"
        ${pkgs.coreutils}/bin/cp -L "${home}/.pi/agent/APPEND_SYSTEM.md" \
          "${home}/.local/state/t3-backup/pi-APPEND_SYSTEM.md"
      '';
      backupCleanupCommand = ''
        set -euo pipefail
        ${pkgs.coreutils}/bin/rm -f \
          "${home}/.local/state/t3-backup/statev2.sqlite" \
          "${home}/.local/state/t3-backup/pi-settings.json" \
          "${home}/.local/state/t3-backup/pi-APPEND_SYSTEM.md"
      '';
      timerConfig = {
        OnCalendar = "*-*-* 04:00:00";
        Persistent = true;
      };
      extraBackupArgs = [
        "--host pc"
        "--tag t3"
      ];
      pruneOpts = [
        # A week of daily snapshots gives granular recovery from recent mistakes.
        "--keep-daily 7"
        # Four weekly snapshots retain roughly a month of weekly rollback points.
        "--keep-weekly 4"
      ];
      runCheck = true;
    };
  };

  systemd.user.services.restic-backups-t3 = lib.mkIf (hostname == "pc") {
    Service = {
      Slice = "background.slice";
      UMask = "0077";
      StateDirectory = "t3-backup";
      StateDirectoryMode = "0700";
      # Streaming backup of the current 16 GiB database gets a 1 GiB memory ceiling.
      MemoryMax = "1G";
      MemorySwapMax = 0;
      # Bound stuck-network work to one hour for the current 16 GiB database.
      TimeoutStartSec = "1h";
      TimeoutStopSec = "30s";
      KillMode = "control-group";
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
