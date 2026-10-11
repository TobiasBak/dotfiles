# Developer command-line tools installed system-wide on NixOS hosts. Omarchy
# installs its equivalents through mise in omarchy/bootstrap.sh.
{ hunk, pkgs }:

let
  nativeLibraries = with pkgs; [
    expat
    glib
    libGL
    stdenv.cc.cc.lib
    libx11
    zlib
  ];
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
in
{
  inherit chromium nativeLibraries;

  # NixOS has no FHS loader path, so uv-managed native wheels need these libraries.
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

  # Tools that work the same on any Linux. The host supplies zsh, OpenSSH,
  # Tailscale, coreutils, CA certificates, xdg-utils, a browser and uv.
  portable = with pkgs; [
    bat
    eza
    fd
    gh
    go
    hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk
    nixd
    nixfmt
    nodejs
    oh-my-zsh
    openssl
    pnpm
    (callPackage ./playwright-cli { inherit chromium; })
    python3
    tmux
    unzip
    (callPackage ./vite-plus { })
    wget
    zsh-syntax-highlighting
  ];
}
