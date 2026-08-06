# Hermes bootstrap

The NixOS module owns Hermes, its container, and its non-secret configuration.
Runtime state and credentials remain under `/var/lib/hermes` on the server.

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
sudo docker exec -it hermes-agent hermes auth add openai-codex
sudo systemctl restart hermes-agent
```

Check the service with `systemctl status hermes-agent` and
`journalctl -u hermes-agent`.
