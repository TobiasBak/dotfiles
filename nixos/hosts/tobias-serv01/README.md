# Hermes

NixOS owns the Hermes package, service, container, mounts, secret handoff,
local SearXNG service, and the initial OpenAI model choice. Hermes owns its
runtime configuration and state under `/var/lib/hermes`.

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

## Web research

SearXNG listens only on `127.0.0.1:8888`. The Hermes service adds that URL to
its generated runtime environment, giving the agent private, keyless web
search without opening a firewall port. Check it with:

```sh
curl --get --data-urlencode 'q=NixOS' \
  --data 'format=json' http://127.0.0.1:8888/search
```

Hermes uses its own current Nixpkgs input instead of the host's stable input.
This keeps its Python/SQLite runtime current without upgrading every package on
the server and developer machines.

## Mutable tools

Hermes can install Node tools into its persistent home. The container sets the
npm prefix to `/home/hermes/.local`, which is already on Hermes' runtime path.
Agent Browser 0.25.3 is the current compatible pin for the container's Node 22;
newer releases require Node 24 or later.

```sh
docker exec -u hermes hermes-agent \
  npm install --global agent-browser@0.25.3
docker exec -u root \
  --env HOME=/home/hermes \
  --env NPM_CONFIG_PREFIX=/home/hermes/.local \
  hermes-agent \
  /home/hermes/.local/bin/agent-browser install --with-deps
docker exec -u root hermes-agent \
  chown -R hermes:hermes /home/hermes/.cache /home/hermes/.local
```

The package and downloaded browser live under the persistent home mount. System
libraries installed into the container layer need reinstalling after a future
structural container recreation.

Check the service with `systemctl status hermes-agent` and
`journalctl -u hermes-agent`, and check local search with
`systemctl status searx`.
