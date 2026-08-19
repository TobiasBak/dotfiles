{ lib, pkgs, ... }:

{
  systemd.tmpfiles.rules = [
    "f /var/lib/hermes/env 0600 hermes hermes - -"
  ];

  services.hermes-agent = {
    enable = true;

    # Keep Hermes' mutable runtime and tools in the persistent container without
    # exposing the Docker socket. The upstream module marks every config key as
    # Nix-managed; override that coarse lock so Hermes can manage its own
    # runtime config while Nix still owns the service and container.
    container = {
      enable = true;
      extraOptions = [
        "--env HERMES_MANAGED="
        "--env NPM_CONFIG_PREFIX=/home/hermes/.local"
        "--env PATH=/home/hermes/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      ];
      extraVolumes = [ "/srv/nas/files:/nas:rw" ];
    };

    settings.model = {
      provider = "openai-codex";
      default = "gpt-5.6-sol";
    };
  };

  # Free, local-only web search for Hermes. The container uses host networking,
  # so it can reach this loopback listener without exposing it to the LAN.
  services.searx = {
    enable = true;
    settings = {
      server = {
        bind_address = "127.0.0.1";
        port = 8888;
        # This only signs local SearXNG sessions; the service is not reachable
        # outside the host, so it is not an authentication secret.
        secret_key = "hermes-local-search";
      };
      search.formats = [
        "html"
        "json"
      ];
    };
  };

  # Both observed USB bridge resets re-enumerated the disk within seconds, but
  # left the mount and Hermes inactive indefinitely. Reassert both once a minute
  # so a returned disk restores the bot without an operator.
  systemd.services.hermes-nas-recovery = {
    description = "Recover the NAS mount used by Hermes";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${pkgs.systemd}/bin/systemctl start srv-nas.mount hermes-agent.service";
    };
  };

  systemd.timers.hermes-nas-recovery = {
    description = "Retry the NAS mount used by Hermes";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "1min";
      OnUnitActiveSec = "1min";
    };
  };

  # Remove the second upstream managed-mode signal on every start, then refresh
  # runtime secrets, including ordinary token rotations. The upstream
  # environmentFiles option only copies during NixOS activation.
  systemd.services.hermes-agent = {
    after = [ "searx.service" ];
    wants = [ "searx.service" ];
    preStart = lib.mkBefore ''
      ${pkgs.coreutils}/bin/rm -f /var/lib/hermes/.hermes/.managed
      ${pkgs.coreutils}/bin/install -o hermes -g hermes -m 0640 \
        /var/lib/hermes/env /var/lib/hermes/.hermes/.env
      ${pkgs.coreutils}/bin/printf '%s\n' \
        'SEARXNG_URL=http://127.0.0.1:8888' \
        'AGENT_BROWSER_EXECUTABLE_PATH=/home/hermes/.agent-browser/chrome' \
        >> /var/lib/hermes/.hermes/.env

      ${pkgs.coreutils}/bin/install -d -o hermes -g hermes -m 0750 \
        /var/lib/hermes/home/.local/bin
      ${pkgs.coreutils}/bin/ln -sfn \
        ${pkgs.gh}/bin/gh /var/lib/hermes/home/.local/bin/gh
      ${pkgs.coreutils}/bin/chown -h hermes:hermes \
        /var/lib/hermes/home/.local/bin/gh

      browser_root=/var/lib/hermes/home/.agent-browser
      chrome_path="$(${pkgs.findutils}/bin/find "$browser_root/browsers" \
        -mindepth 2 -maxdepth 2 -type f -name chrome -perm -0100 \
        -print -quit 2>/dev/null || true)"
      if [ -n "$chrome_path" ]; then
        chrome_dir="$(${pkgs.coreutils}/bin/basename \
          "$(${pkgs.coreutils}/bin/dirname "$chrome_path")")"
        ${pkgs.coreutils}/bin/ln -sfn \
          "browsers/$chrome_dir/chrome" "$browser_root/chrome"
        ${pkgs.coreutils}/bin/chown -h hermes:hermes "$browser_root/chrome"
      fi
    '';
  };
}
