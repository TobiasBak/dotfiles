{ ... }:

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

    # tmpfiles creates this outside the Nix store without overwriting it.
    # It contains DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USERS.
    environmentFiles = [ "/var/lib/hermes/env" ];
  };
}
