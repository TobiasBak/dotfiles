{
  buildNpmPackage,
  lib,
  makeWrapper,
  nodejs,
}:

buildNpmPackage {
  pname = "vite-plus";
  version = "0.2.4";

  src = ./.;
  npmDepsHash = "sha256-98Y0wmfJF3R3F43F/ql+faH5s1RHkv77WiTEddqXSrQ=";

  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/node_modules/vite-plus-wrapper" "$out/bin"
    cp -R node_modules/. "$out/lib/node_modules/vite-plus-wrapper/node_modules"

    for bin in vp vpr oxfmt oxlint; do
      makeWrapper ${nodejs}/bin/node "$out/bin/$bin" \
        --add-flags "$out/lib/node_modules/vite-plus-wrapper/node_modules/vite-plus/bin/$bin"
    done

    runHook postInstall
  '';

  meta = {
    description = "Vite+ unified toolchain for the web";
    homepage = "https://viteplus.dev/guide";
    license = lib.licenses.mit;
    mainProgram = "vp";
    platforms = lib.platforms.linux;
  };
}
