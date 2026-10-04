{
  bash,
  coreutils,
  replaceVarsWith,
  systemd,
}:

replaceVarsWith {
  name = "pc-workload";
  src = ../../../scripts/pc-workload.sh.in;
  dir = "bin";
  isExecutable = true;
  replacements = {
    bash = "${bash}/bin/bash";
    systemd_run = "${systemd}/bin/systemd-run";
    nice = "${coreutils}/bin/nice";
  };
}
