{
  buildNpmPackage,
  fetchurl,
  lib,
  makeWrapper,
  nodejs_22,
}:

buildNpmPackage {
  pname = "pi-coding-agent";
  version = "0.80.6";

  src = ./.;
  npmDepsHash = "sha256-tqsJwcM/cDlRpnRNUhzOc0GB5uvpUMKH7fIUhn1g/lc=";

  piArchive = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.80.6.tgz";
    hash = "sha256-KndjRkCy2G2Q0kCHu2dVns8jZuD7UqQsVe7UFhR9pBE=";
  };

  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    tar -xzf "$piArchive" --strip-components=1 -C "$out/lib/pi"
    cp -R node_modules "$out/lib/pi/"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/dist/cli.js"

    runHook postInstall
  '';

  meta = {
    description = "Terminal coding agent with tool use and extension support";
    homepage = "https://github.com/earendil-works/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = lib.platforms.linux;
  };
}
