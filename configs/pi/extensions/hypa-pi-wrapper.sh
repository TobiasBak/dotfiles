#!/bin/sh
set -eu

# Hypa uses .NET's generic host, whose default config reload watcher recursively
# watches the process working directory. A Pi session started from $HOME can
# otherwise spend seconds registering watches before every tool command.
export DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE=false

exec "$HOME/.local/bin/hypa" "$@"
