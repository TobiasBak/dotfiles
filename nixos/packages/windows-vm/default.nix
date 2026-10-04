{
  lib,
  stdenvNoCC,
  makeWrapper,
  aria2,
  bash,
  cdrkit,
  coreutils,
  curl,
  findutils,
  gnugrep,
  gnused,
  iproute2,
  jq,
  openssh,
  python3,
  qemu_kvm,
  socat,
  systemd,
  util-linux,
  virt-viewer,
  xmlstarlet,
  callPackage,
}:

let
  runtimeInputs = [
    aria2
    bash
    cdrkit
    coreutils
    curl
    findutils
    gnugrep
    gnused
    iproute2
    jq
    openssh
    python3
    qemu_kvm
    socat
    systemd
    util-linux
    virt-viewer
    xmlstarlet
    (callPackage ../pc-workload { })
  ];
in
stdenvNoCC.mkDerivation {
  pname = "oip-windows-vm";
  version = "1";
  src = lib.fileset.toSource {
    root = ../../../tools/windows-vm;
    fileset = lib.fileset.unions [
      ../../../tools/windows-vm/oip-windows-vm
      ../../../tools/windows-vm/bootstrap
      ../../../tools/windows-vm/verify.ps1
    ];
  };
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 oip-windows-vm "$out/libexec/windows-vm/oip-windows-vm"
    cp -r bootstrap verify.ps1 "$out/libexec/windows-vm/"
    patchShebangs "$out/libexec/windows-vm/oip-windows-vm"
    mkdir -p "$out/bin"
    makeWrapper "$out/libexec/windows-vm/oip-windows-vm" "$out/bin/oip-windows-vm" \
      --prefix PATH : ${lib.makeBinPath runtimeInputs}
    runHook postInstall
  '';
  passthru = { inherit runtimeInputs; };
  meta = {
    description = "Shared rootless Windows qualification VM lab";
    mainProgram = "oip-windows-vm";
    platforms = [ "x86_64-linux" ];
  };
}
