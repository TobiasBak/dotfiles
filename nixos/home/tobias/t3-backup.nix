# Nightly restic backup of T3 and Pi state from the pc, whichever OS it boots.
{ config, pkgs, ... }:

let
  home = config.home.homeDirectory;
in

{
  home.file.".local/bin/restic-t3".source = "${config.home.path}/bin/restic-t3";

  services.restic = {
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

  systemd.user.services.restic-backups-t3 = {
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
}
