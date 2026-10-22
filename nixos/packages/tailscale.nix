{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  getent,
  iproute2,
  iptables,
  shadow,
  procps,
}:

stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "tailscale";
  version = "1.104.2";

  src = fetchurl {
    url = "https://pkgs.tailscale.com/stable/tailscale_${finalAttrs.version}_amd64.tgz";
    hash = "sha256-US9hPtfQT8coL33FvXaqEFquKBaPu5NX63SevLwp8K4=";
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    install -Dm755 tailscale "$out/bin/tailscale"
    install -Dm755 tailscaled "$out/bin/tailscaled"
    wrapProgram "$out/bin/tailscaled" \
      --prefix PATH : ${
        lib.makeBinPath [
          getent
          iproute2
          iptables
          shadow
        ]
      } \
      --suffix PATH : ${lib.makeBinPath [ procps ]}

    install -Dm444 systemd/tailscaled.service "$out/lib/systemd/system/tailscaled.service"
    substituteInPlace "$out/lib/systemd/system/tailscaled.service" \
      --replace-fail /usr/sbin/tailscaled "$out/bin/tailscaled"
    sed -i '/^EnvironmentFile=/d' "$out/lib/systemd/system/tailscaled.service"
    install -Dm444 systemd/tailscale-online.target "$out/lib/systemd/system/tailscale-online.target"
    install -Dm444 systemd/tailscale-wait-online.service "$out/lib/systemd/system/tailscale-wait-online.service"
    substituteInPlace "$out/lib/systemd/system/tailscale-wait-online.service" \
      --replace-fail /usr/bin/tailscale "$out/bin/tailscale"

    runHook postInstall
  '';

  meta = {
    description = "Tailscale official binary with the TS-2026-013 certificate distrust fix";
    homepage = "https://tailscale.com";
    license = lib.licenses.bsd3;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [ "x86_64-linux" ];
    mainProgram = "tailscale";
  };
})
