{ pkgs, ... }:

let
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

  # WSL setup is driven from Windows automation, so first rebuilds must not
  # depend on an interactive password prompt.
  security.sudo.wheelNeedsPassword = false;

  # Let uv-managed native wheels find nix-ld libraries in WSL. Keep this
  # compatibility path out of native desktop sessions.
  environment.sessionVariables.LD_LIBRARY_PATH = "/run/current-system/sw/share/nix-ld/lib";

  home-manager.users.tobias.imports = [ ../../home/tobias/wsl.nix ];

  environment.systemPackages = [
    windowsCode
    windowsPowerShell
  ];

  # Keep this at the generated install release unless you intentionally migrate it.
  system.stateVersion = "25.11";
}
