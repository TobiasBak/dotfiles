{ lib, pkgs, ... }:

{
  systemd.tmpfiles.rules = [
    "f /var/lib/hermes/env 0600 hermes hermes - -"
  ];

  services.hermes-agent = {
    enable = true;

    # Hermes' Nix support is best-effort. Keep its mutable runtime and tools in
    # the module's persistent container without exposing the NAS or Docker socket.
    container.enable = true;

    settings.model = {
      provider = "openai-codex";
      default = "gpt-5.6-sol";
    };
  };

  # Refresh runtime secrets on every start, including ordinary token rotations.
  # The upstream environmentFiles option only copies during NixOS activation.
  systemd.services.hermes-agent.preStart = lib.mkBefore ''
    ${pkgs.coreutils}/bin/install -o hermes -g hermes -m 0640 \
      /var/lib/hermes/env /var/lib/hermes/.hermes/.env
  '';
}
