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

  networking.hostName = "pc";

  environment.systemPackages = [ piWhisperTranscribe ];

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
