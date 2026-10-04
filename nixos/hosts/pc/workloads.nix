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
    # Below default I/O weight 100, not a cap or a measured optimum.
    # BFQ and io delegation make this effective; see workloads.md.
    IOWeight = 10;
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

  # Preserve systemd 260's default delegation and add I/O for user scopes.
  systemd.services."user@".serviceConfig.Delegate = "cpu io memory pids";

  # A top-level system slice competes with user.slice. Lowering only the
  # daemon inside system.slice would leave system.slice's root share intact.
  systemd.slices.background.sliceConfig = backgroundSlicePolicy;
  systemd.user.slices.background.sliceConfig = backgroundSlicePolicy;

  # Linux 6.18 on pc has BFQ=m and BFQ_GROUP_IOSCHED=y. The current NVMe
  # scheduler 'none' ignores weights. systemd 260 writes io.bfq.weight.
  boot.kernelModules = [ "bfq" ];
  services.udev.extraRules = ''
    ACTION=="add|change", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", KERNEL=="nvme*n*", ATTR{queue/scheduler}="bfq"
  '';

  environment.systemPackages = [ pcWorkload ];
}
