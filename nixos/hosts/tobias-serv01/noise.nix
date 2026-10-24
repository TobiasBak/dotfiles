{ lib, pkgs, ... }:
let
  defaults = { governor = "powersave"; turbo = true; };
  policy = pkgs.writeText "dev-loop-lab-noise-policy.json" (builtins.toJSON defaults);
  backgroundWeights = { CPUWeight = 10; IOWeight = 10; };
  state = pkgs.writeScriptBin "dev-loop-lab-noise-state" ''
    #!${pkgs.python3}/bin/python3
    ${builtins.readFile ./noise_state.py}
  '';
in
{
  environment.systemPackages = [ state ];
  environment.etc."dev-loop-lab-noise.json".source = policy;
  powerManagement.cpuFreqGovernor = lib.mkForce defaults.governor;
  systemd.services.nix-gc.serviceConfig = backgroundWeights;
  systemd.services.nix-optimise.serviceConfig = backgroundWeights;
  systemd.services.systemd-journald.serviceConfig = backgroundWeights;
  systemd.services.dev-loop-lab-noise = {
    description = "Apply measured shared Lab CPU policy";
    wantedBy = [ "multi-user.target" ];
    after = [ "cpufreq.service" ];
    restartTriggers = [ policy ];
    postStart = "${state}/bin/dev-loop-lab-noise-state background candidate";
    path = [ pkgs.systemd ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${state}/bin/dev-loop-lab-noise-state restore control";
    };
  };
}
