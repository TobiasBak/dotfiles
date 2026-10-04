{ pkgs, ... }:

let
  pcWorkload = pkgs.replaceVarsWith {
    name = "pc-workload";
    src = ../../../scripts/pc-workload.sh.in;
    dir = "bin";
    isExecutable = true;
    replacements = {
      bash = "${pkgs.bash}/bin/bash";
      systemd_run = "${pkgs.systemd}/bin/systemd-run";
      nice = "${pkgs.coreutils}/bin/nice";
    };
  };
  backgroundSlicePolicy = {
    # systemd's background CPU default is 30, below normal slice weight 100.
    CPUWeight = 30;
  };
in
{
  # 16 logical CPUs: one 4-worker Nix build + a 4-vCPU VM + one 4-worker
  # native run leaves 4 threads unassigned by these settings, not reserved.
  # The previous auto/0 settings allowed overlapping cargo -j16 builds.
  nix.settings = {
    max-jobs = 1;
    cores = 4;
  };

  nix.daemonCPUSchedPolicy = "batch";
  systemd.services.nix-daemon.serviceConfig = {
    # +10 lowers CPU priority below ordinary nice 0; not a measured optimum.
    Nice = 10;
    Slice = "background.slice";
  };

  # A top-level system slice competes with user.slice. Lowering only the
  # daemon inside system.slice would leave system.slice's root share intact.
  systemd.slices.background.sliceConfig = backgroundSlicePolicy;
  systemd.user.slices.background.sliceConfig = backgroundSlicePolicy;

  environment.systemPackages = [ pcWorkload ];
}
