{
  fetchurl,
  gnutar,
  gzip,
  lib,
  stdenvNoCC,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "codexbar";
  version = "0.46.0";

  src = fetchurl {
    url = "https://github.com/steipete/CodexBar/releases/download/v${finalAttrs.version}/CodexBarCLI-v${finalAttrs.version}-linux-musl-x86_64.tar.gz";
    hash = "sha256-yMrOpu1WIv2sGVgvY9qf2XCoX2AXMSqR2b8bQDRU6os=";
  };

  dontUnpack = true;
  nativeBuildInputs = [
    gnutar
    gzip
  ];

  installPhase = ''
    runHook preInstall

    mkdir -p unpacked "$out/bin"
    tar -xzf "$src" -C unpacked
    install -m 0755 unpacked/CodexBarCLI "$out/bin/codexbar"

    runHook postInstall
  '';

  meta = {
    description = "CLI for showing AI coding-provider usage limits";
    homepage = "https://github.com/steipete/CodexBar";
    license = lib.licenses.mit;
    mainProgram = "codexbar";
    platforms = [ "x86_64-linux" ];
  };
})
