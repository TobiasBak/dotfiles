# Hermes

NixOS owns the Hermes package, service, container, mounts, secret handoff, and
the initial OpenAI model choice. Hermes owns its runtime configuration and
state under `/var/lib/hermes`.

This lets the agent change settings such as its reasoning effort and keep those
changes across restarts. It deliberately cannot edit the host's Nix files,
invoke `nixos-rebuild`, access the NAS, or control Docker.

After the first activation, add the Discord bot token and Tobias's numeric
Discord user ID without putting either in Git:

```sh
sudoedit /var/lib/hermes/env
sudo systemctl restart hermes-agent
```

```dotenv
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_USERS=...
```

Then authenticate Hermes against the ChatGPT subscription. The device flow
prints a URL and one-time code that can be completed on another machine:

```sh
docker exec -it -u hermes hermes-agent \
  /data/current-package/bin/hermes auth add openai-codex
sudo systemctl restart hermes-agent
```

Run other Hermes administration commands through the same owner-scoped
`docker exec` prefix. Hermes protects its credential directory with mode 0700,
so the host CLI cannot safely share that state with a different user.

For example, the agent or an administrator can persist a reasoning level with:

```sh
docker exec -u hermes hermes-agent \
  /data/current-package/bin/hermes config set agent.reasoning_effort xhigh
```

The Nix-declared provider and model are reapplied on a NixOS activation. Other
Hermes settings are preserved.

Check the service with `systemctl status hermes-agent` and
`journalctl -u hermes-agent`.
