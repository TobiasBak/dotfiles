{
  hunk,
  pkgs,
  ...
}:

let
  nativeLibraries = with pkgs; [
    expat
    glib
    libGL
    stdenv.cc.cc.lib
    libx11
    zlib
  ];
  uvWithNativeLibraries = pkgs.symlinkJoin {
    name = "uv-with-native-libraries";
    paths = [ pkgs.uv ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/uv \
        --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath nativeLibraries}"
      wrapProgram $out/bin/uvx \
        --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath nativeLibraries}"
    '';
  };
  chromium = pkgs.symlinkJoin {
    name = "chromium-agent-safe";
    paths = [ pkgs.chromium ];
    postBuild = ''
      rm "$out/bin/chromium" "$out/bin/chromium-browser"
      ln -s "${pkgs.chromium}/bin/chromium" "$out/bin/chromium-interactive"
      ln -s chromium "$out/bin/chromium-browser"

      cat > "$out/bin/chromium" <<'EOF'
      #!${pkgs.runtimeShell}
      set -eu

      if [ -z "''${XDG_RUNTIME_DIR:-}" ]; then
        echo "chromium: XDG_RUNTIME_DIR is required for the isolated automation profile" >&2
        exit 1
      fi

      automation_profile="$(${pkgs.coreutils}/bin/mktemp -d "''${XDG_RUNTIME_DIR}/chromium-automation.XXXXXX")"
      cleanup() {
        ${pkgs.coreutils}/bin/rm -rf -- "$automation_profile"
      }
      trap cleanup EXIT

      "${pkgs.chromium}/bin/chromium" \
        --password-store=basic \
        --user-data-dir="$automation_profile" \
        --no-first-run \
        --no-default-browser-check \
        "$@"
      EOF
      chmod +x "$out/bin/chromium"

      rm "$out/share/applications"
      mkdir "$out/share/applications"
      cp "${pkgs.chromium}/share/applications/chromium-browser.desktop" \
        "$out/share/applications/chromium-browser.desktop"
      substituteInPlace "$out/share/applications/chromium-browser.desktop" \
        --replace-fail "Exec=chromium" "Exec=chromium-interactive"
    '';
  };
  playwrightCli = pkgs.callPackage ../packages/playwright-cli { inherit chromium; };
  vitePlus = pkgs.callPackage ../packages/vite-plus { };
in
{
  imports = [
    ./base.nix
    ./users/tobias.nix
  ];

  programs.zsh.enable = true;
  # Both Oh My Zsh and the fast tmux shell initialize completion in .zshrc.
  # Keep completion files available without running compinit twice per shell.
  programs.zsh.enableGlobalCompInit = false;
  services.tailscale.enable = true;

  # Supports native PyPI wheels and other dynamically linked development tools.
  programs.nix-ld = {
    enable = true;
    libraries = nativeLibraries;
  };

  environment.sessionVariables.ZSH = "${pkgs.oh-my-zsh}/share/oh-my-zsh";

  home-manager = {
    backupFileExtension = "pre-home-manager";
    useGlobalPkgs = true;
    useUserPackages = true;
    users.tobias.imports = [ ../home/tobias/common.nix ];
  };

  environment.systemPackages = with pkgs; [
    bat
    cacert
    coreutils
    chromium
    eza
    fd
    gh
    hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk
    nixd
    nixfmt
    nodejs
    oh-my-zsh
    openssl
    openssh
    pnpm
    playwrightCli
    python3
    tailscale
    tmux
    unzip
    uvWithNativeLibraries
    vitePlus
    wget
    xdg-utils
    zsh
    zsh-syntax-highlighting
  ];
}
