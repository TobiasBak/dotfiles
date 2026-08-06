{ ... }:

{
  systemd.tmpfiles.rules = [
    "f /var/lib/hermes/env 0600 hermes hermes - -"
  ];

  services.hermes-agent = {
    enable = true;
    addToSystemPackages = true;

    # Hermes' Nix support is best-effort. Keep its mutable runtime and tools in
    # the module's persistent container without exposing the NAS or Docker socket.
    container = {
      enable = true;

      # Let Tobias use the host CLI against the gateway's persistent state.
      # The upstream module also adds him to the hermes group and installs the
      # container-routing marker in his ~/.hermes directory.
      hostUsers = [ "tobias" ];
    };

    settings.model = {
      provider = "openai-codex";
      default = "gpt-5.6-sol";
    };

    # tmpfiles creates this outside the Nix store without overwriting it.
    # It contains DISCORD_BOT_TOKEN and DISCORD_ALLOWED_USERS.
    environmentFiles = [ "/var/lib/hermes/env" ];
  };
}
