{ lib, pkgs, ... }:

{
  systemd.tmpfiles.rules = [
    "f /var/lib/hermes/env 0600 hermes hermes - -"
  ];

  services.hermes-agent = {
    enable = true;

    # Keep Hermes' mutable runtime and tools in the persistent container without
    # exposing the NAS or Docker socket. The upstream module marks every config
    # key as Nix-managed; override that coarse lock so Hermes can manage its own
    # runtime config while Nix still owns the service and container.
    container = {
      enable = true;
      extraOptions = [
        "--env HERMES_MANAGED="
        "--env NPM_CONFIG_PREFIX=/home/hermes/.local"
      ];
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
        >> /var/lib/hermes/.hermes/.env
    '';
  };
}
