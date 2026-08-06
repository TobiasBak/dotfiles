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
      extraOptions = [ "--env HERMES_MANAGED=" ];
    };

    settings.model = {
      provider = "openai-codex";
      default = "gpt-5.6-sol";
    };
  };

  # Remove the second upstream managed-mode signal on every start, then refresh
  # runtime secrets, including ordinary token rotations. The upstream
  # environmentFiles option only copies during NixOS activation.
  systemd.services.hermes-agent.preStart = lib.mkBefore ''
    ${pkgs.coreutils}/bin/rm -f /var/lib/hermes/.hermes/.managed
    ${pkgs.coreutils}/bin/install -o hermes -g hermes -m 0640 \
      /var/lib/hermes/env /var/lib/hermes/.hermes/.env
  '';
}
