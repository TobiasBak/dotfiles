{ config, pkgs, ... }:

let
  whisperModel = pkgs.fetchurl {
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
    hash = "sha256-OUIhcJzVrR9AxG5gMcphvOiJMebgiMGIKUxtWlX/p+I=";
  };

  piWhisperTranscribe = pkgs.writeShellApplication {
    name = "pi-whisper-transcribe";
    runtimeInputs = [ pkgs.whisper-cpp-vulkan ];
    text = ''
      if [ "$#" -ne 1 ]; then
        echo "Usage: $0 <audio-file>" >&2
        exit 2
      fi

      exec whisper-cli -m ${whisperModel} -l auto -nt -np -f "$1"
    '';
  };

  rdpClient = pkgs.writeShellApplication {
    name = "rdp";
    runtimeInputs = [ pkgs.freerdp ];
    text = ''
      if [ "$#" -ne 1 ] || [[ "$1" != *@* ]]; then
        echo "Usage: rdp <user>@<host>" >&2
        exit 2
      fi

      username="''${1%%@*}"
      host="''${1#*@}"
      if [ -z "$username" ] || [ -z "$host" ]; then
        echo "Usage: rdp <user>@<host>" >&2
        exit 2
      fi

      exec xfreerdp "/u:$username" "/v:$host" +dynamic-resolution +clipboard /cert:tofu /from-stdin:force
    '';
  };

  rdpLauncher = pkgs.writeShellApplication {
    name = "rdp-launcher";
    runtimeInputs = [
      pkgs.fuzzel
      pkgs.libnotify
      rdpClient
    ];
    text = ''
      target_error=""
      while true; do
        prompt_args=(
          --dmenu
          "--prompt-only=Remote Desktop: "
          "--placeholder=user@host"
        )
        if [ -n "$target_error" ]; then
          prompt_args+=("--mesg=$target_error")
        fi

        target="$(fuzzel "''${prompt_args[@]}")" || exit 0
        username="''${target%%@*}"
        host="''${target#*@}"
        if [[ "$target" == *@* ]] && [ -n "$username" ] && [ -n "$host" ]; then
          break
        fi

        target_error="Use user@host, for example jd@larsbroe-runner."
      done

      password="$(fuzzel \
        --dmenu \
        --password \
        "--prompt-only=Password: " \
        "--mesg=$target")" || exit 0

      if ! printf '%s\n' "$password" | rdp "$target"; then
        notify-send --urgency=critical "Remote Desktop" "Connection to $target failed"
        exit 1
      fi
    '';
  };

  rdpDesktopItem = pkgs.makeDesktopItem {
    name = "remote-desktop";
    desktopName = "Remote Desktop";
    genericName = "RDP client";
    comment = "Connect to a remote desktop";
    exec = "rdp-launcher";
    icon = "computer";
    categories = [
      "Network"
      "RemoteAccess"
    ];
    keywords = [
      "RDP"
      "Remote Desktop"
    ];
  };
in
{
  nixpkgs.overlays = [
    (_final: previous: {
      btop = previous.btop.override { cudaSupport = true; };
    })
  ];

  imports = [
    ../../modules/developer.nix
    ../../modules/desktop-niri.nix
    ./hardware-configuration.nix
  ];

  services.voxtype = {
    enable = true;
    transcriber = piWhisperTranscribe;
  };

  networking.hostName = "pc";

  programs.steam.enable = true;

  # Keep the user manager available for T3 Code's official per-user background service.
  users.users.tobias.linger = true;

  # T3 Code is reachable from localhost and the Tailnet, but not the LAN.
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 3773 ];

  fileSystems."/mnt/data-2tb" = {
    device = "/dev/disk/by-uuid/0e9d1e0f-a81d-4b66-981a-d3502dc45b1d";
    fsType = "ext4";
    options = [ "nofail" ];
  };

  # T3 Code's official updater may compile node-pty when a release lacks a matching prebuild.
  environment.systemPackages = [
    piWhisperTranscribe
    pkgs.gcc
    pkgs.gnumake
    rdpClient
    rdpDesktopItem
    rdpLauncher
  ];

  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.nvidia = {
    modesetting.enable = true;
    powerManagement.enable = false;
    powerManagement.finegrained = false;
    open = true;
    nvidiaSettings = true;
    package = config.boot.kernelPackages.nvidiaPackages.stable;
  };

  # Work around NVIDIA retaining an unnecessarily large Wayland buffer pool.
  environment.etc."nvidia/nvidia-application-profiles-rc.d/50-limit-free-buffer-pool-in-wayland-compositors.json".text =
    builtins.toJSON {
      rules = [
        {
          pattern = {
            feature = "procname";
            matches = "niri";
          };
          profile = "Limit Free Buffer Pool On Wayland Compositors";
        }
      ];
      profiles = [
        {
          name = "Limit Free Buffer Pool On Wayland Compositors";
          settings = [
            {
              key = "GLVidHeapReuseRatio";
              value = 0;
            }
          ];
        }
      ];
    };

  # Keep this at the release used for the first installation.
  system.stateVersion = "25.11";
}
