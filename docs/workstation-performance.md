# PC performance review

## September 5, 2026

Targets: desktop/T3 responsiveness and build/test throughput under concurrent
agent work. Inspection covered the live host, historical kernel logs, NixOS,
desktop services, shell/Git/tmux startup, storage, networking and power policy.
Measurements below were taken under light load, not during a reported stutter.

Hardware: Ryzen 7 7800X3D, 8 cores/16 threads, 32 GB RAM, RTX 5070, Kingston
NV3 1 TB system/repository drive and Fury Renegade 2 TB data drive. Ethernet
negotiated 2.5 Gb/s. Active displays were 4K at 120 Hz and 4K at 60 Hz.

## Activated fixes

- `programs.zsh.enableGlobalCompInit = false` leaves completion initialization
  with the existing Oh My Zsh and fast tmux paths. Completion files remain
  installed. This shared developer setting also affects WSL and the laptop.
- Move T3's update from Home Manager activation to the end of the explicit PC
  rebuild script. Boot spent about 11 seconds trying the updater before its
  user manager was available, then continued after failure. Explicit script
  rebuilds still update T3 through a detached user service. Plain
  `nixos-rebuild` and Home Manager activation no longer update it. Updater
  completion is asynchronous and its result is in the user journal.

Shell comparison used the current and proposed generated global zshrc with
the same real user configuration and warm caches in the T3 checkout. Seven
runs per case, automatic Oh My Zsh updates disabled during measurement:

| Interactive path | Current median | Proposed median |
| --- | ---: | ---: |
| Normal | 71.93 ms | 51.68 ms |
| Fast tmux | 33.43 ms | 17.16 ms |

Both paths retained Git completion. These are staged startup comparisons,
not a measurement after system activation. Ordinary agent `zsh -lc`
commands already started in about 2 ms and do not benefit from this change.

Validation: exact PC toplevel built successfully, shell syntax/ShellCheck and
Nix formatting passed, independent patch review found no blocking issues.
Tobias authorized activation, which completed at 09:16 CEST. The detached
updater then successfully updated and restarted T3 with
`t3@0.0.39-nightly.20260905.1285`. Home Manager completed without invoking
the updater. The running system matches the built generation.

After activation, seven fresh interactive launches per path measured median
startup of 54.35 ms normally and 18.00 ms for the fast tmux path, with Git
completion available in both. Update checks were disabled for timing. No
system units failed; the previously failed memory-curator user unit remains
unrelated and unchanged. Existing unrelated working-tree changes were retained.
No reboot was performed; boot-time savings still need measurement.

## Ranked next changes

1. **Memory capacity and workload ownership.** On September 1–2, T3's cgroup
   killed QEMU processes and Chromium. The September 2 kernel dump recorded
   both its 24 GiB memory cap and 4 GiB swap cap exhausted. Two killed VMs
   held roughly 6.6 and 5.7 GiB resident memory; the September 1 VM held about
   8 GiB. Keep desktop headroom rather than simply raising the cap. Review
   simultaneous VM ownership and consider more RAM before a CPU/GPU purchase.
2. **Nix build concurrency.** Effective `max-jobs = 16` and `cores = 0` allow
   16 builds each told to use all 16 logical CPUs. For builders honoring this
   setting, nominal concurrency can reach 256 workers. Bound that product to
   the machine and compare representative builds before choosing the split.
   This does not control pnpm, test runners or VMs launched outside Nix.
   [Nix's concurrency model](https://releases.nixos.org/nix/nix-2.27.0/manual/advanced-topics/cores-vs-jobs.html).
3. **Compressed swap.** Neither zswap nor zram was active. Trial zswap with
   the existing disk swap to reduce swap I/O, then measure compression, CPU
   cost and responsiveness under pressure. This is not extra physical RAM
   and does not remove the T3 cgroup limits.
   [Kernel zswap documentation](https://www.kernel.org/doc/html/latest/admin-guide/mm/zswap.html).
4. **Interactive scheduling.** Desktop and T3 service CPU weights currently
   have no explicit preference. Compare desktop latency during competing
   builds before setting weights. Preserve idle-machine build throughput;
   avoid global CPU quotas or moving T3 away from its memory cap by accident.
5. **Firmware and graphics.** Firmware consumed 54.8 seconds of the 83.4-second
   boot. Check RAM configuration and firmware startup separately from Linux.
   Historical NVIDIA allocation errors warrant correlation with stutters,
   not an assumption that the GPU is too weak. Configured RAM speed and SSD
   SMART health remain unread because those interfaces require root access.

## Leave alone unless new evidence changes the decision

- CPU uses active AMD P-state with `balance_performance`, boost enabled.
  The governor name `powersave` alone does not establish poor performance.
  Light-load CPU/GPU temperatures were about 42/35°C; sustained cooling was
  not tested. [AMD P-state](https://docs.kernel.org/admin-guide/pm/amd-pstate.html).
- Niri animations are already off. Workspace/audio providers are event-driven.
  A 20-second sample showed Niri at 3.4% of one CPU core and both Quickshell
  processes below tick resolution. Chromium's renderer/GPU/browser processes
  used 9.4/6.15/1.55% respectively, without a reproduced stutter.
- Both SSD links run PCIe 4.0 ×4. Root was 69% full, data 39%; weekly TRIM and
  Nix maintenance succeeded. Early I/O pressure was not sustained in later
  samples. Moving repositories or changing filesystem/scheduler settings is
  not yet justified by a measured build bottleneck.
- Storage is dominated by VM images, Steam and caches: approximately 158 GB
  of Windows VM state, 104 GB of Steam, 46 GB of repositories and 21 GB of
  cache. These `du -h` figures are rounded binary units. Deleting caches can
  make subsequent builds slower; no cleanup was performed.
- Git status was mostly 1–9 ms across repositories, about 27 ms in T3. The
  normal prompt runs it synchronously; tmux already uses branch-only lookup.
  Global Git tuning is low priority.
- Ethernet showed no interface errors. No measured reason to change DNS,
  TCP settings, network management or Tailscale.
