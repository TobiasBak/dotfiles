{ pkgs, ... }:

let
  windowsBrowser = pkgs.writeShellApplication {
    name = "wslview";
    text = ''
      if (( $# != 1 )); then
        echo "Usage: wslview <URL-or-path>" >&2
        exit 2
      fi

      target="$1"
      case "$target" in
        [a-zA-Z]*:*) ;;
        *)
          if [[ ! -e "$target" ]]; then
            echo "wslview: target does not exist: $target" >&2
            exit 1
          fi

          if ! wslpath_bin="$(command -v wslpath)"; then
            echo "wslview: wslpath not found." >&2
            exit 127
          fi
          target="$("$wslpath_bin" -w "$target")"
          ;;
      esac

      handler="/mnt/c/Windows/System32/rundll32.exe"
      if [[ ! -x "$handler" ]]; then
        echo "wslview: Windows URL handler not found." >&2
        exit 127
      fi

      exec "$handler" url.dll,FileProtocolHandler "$target"
    '';
  };

  windowsXdgOpen = pkgs.writeShellApplication {
    name = "xdg-open";
    text = ''
      exec ${windowsBrowser}/bin/wslview "$@"
    '';
  };

  windowsPowerShell = pkgs.writeShellScriptBin "powershell.exe" ''
    executable="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    if [ -x "$executable" ]; then
      exec "$executable" "$@"
    fi

    echo "powershell.exe: Windows PowerShell not found." >&2
    exit 127
  '';

  windowsCode = pkgs.writeShellScriptBin "code" ''
    for candidate in \
      "/mnt/c/Users/''${USER}/AppData/Local/Programs/Microsoft VS Code/bin/code" \
      "/mnt/c/Users/tobias/AppData/Local/Programs/Microsoft VS Code/bin/code" \
      "/mnt/c/Program Files/Microsoft VS Code/bin/code"
    do
      if [ -x "$candidate" ]; then
        exec "$candidate" "$@"
      fi
    done

    echo "code: Windows VS Code CLI not found." >&2
    exit 127
  '';
in
{
  imports = [ ../../modules/developer.nix ];

  wsl = {
    enable = true;
    defaultUser = "tobias";
    startMenuLaunchers = true;
    useWindowsDriver = true;
    wslConf.interop.appendWindowsPath = false;
  };

  networking.hostName = "nixos-wsl";

  virtualisation.docker.enable = true;
  users.users.tobias.extraGroups = [ "docker" ];

  # WSL setup is driven from Windows automation, so first rebuilds must not
  # depend on an interactive password prompt.
  security.sudo.wheelNeedsPassword = false;

  home-manager.users.tobias.imports = [ ../../home/tobias/wsl.nix ];

  environment.systemPackages = [
    (pkgs.lib.hiPrio windowsXdgOpen)
    pkgs.docker-compose
    windowsBrowser
    windowsCode
    windowsPowerShell
  ];

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
