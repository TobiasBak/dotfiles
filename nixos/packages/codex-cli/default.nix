{
  buildNpmPackage,
  lib,
  makeWrapper,
  nodejs,
}:

buildNpmPackage {
  pname = "codex-cli";
  version = "0.144.1";

  src = ./.;
  npmDepsHash = "sha256-5ip0BrXs0Vsp5ys6MIYK/63T5KRxT5RIHmMQu4T1YxE=";

  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/codex" "$out/bin"
    cp -R node_modules "$out/lib/codex/"

    makeWrapper ${nodejs}/bin/node "$out/bin/codex" \
      --add-flags "$out/lib/codex/node_modules/@openai/codex/bin/codex.js"

    runHook postInstall
  '';

  meta = {
    description = "OpenAI Codex CLI";
    homepage = "https://github.com/openai/codex";
    license = lib.licenses.asl20;
    mainProgram = "codex";
    platforms = lib.platforms.linux;
  };
}
