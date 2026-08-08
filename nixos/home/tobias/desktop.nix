{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:

let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  hostname = osConfig.networking.hostName;
  linkFromDotfiles = path: {
    source = config.lib.file.mkOutOfStoreSymlink "${dotfiles}/${path}";
    force = true;
  };
in

{
  # Treat each explicit pc activation as a request to move T3 Code to the
  # newest npm nightly through its supported in-place updater.
  home.activation.updateT3Code = lib.mkIf (hostname == "pc") (
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run ${pkgs.nodejs}/bin/npx --yes t3@nightly service update
    ''
  );

  home.file = {
    # Niri's generated entry point is the only file here that is not a direct
    # repository link: it selects the portable config and this machine's
    # output layout at evaluation time.
    ".config/niri/config.kdl".text = ''
      include "${dotfiles}/configs/niri/common.kdl"
      include "${dotfiles}/nixos/hosts/${hostname}/niri.kdl"
    '';
    ".config/ghostty/config" = linkFromDotfiles "configs/ghostty/config.ghostty";
    ".config/htop" = linkFromDotfiles "configs/htop";
    ".config/mako" = linkFromDotfiles "configs/mako";
    ".config/quickshell" = linkFromDotfiles "configs/quickshell";
    ".config/Code/User" = linkFromDotfiles "configs/Code/User";
    ".config/discord/settings.json" = linkFromDotfiles "configs/discord/settings.json";
    ".config/systemd/user/t3code.service.d/local.conf" = linkFromDotfiles "configs/t3code/service.conf";

    "Pictures/Wallpapers" = linkFromDotfiles "assets/wallpapers";
  };

  systemd.user.services.taildrop-receiver = {
    Unit = {
      Description = "Receive Tailscale Taildrop files";
      After = [ "network-online.target" ];
    };
    Service = {
      ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p %h/Phone/Inbox";
      ExecStart = "${pkgs.tailscale}/bin/tailscale file get --loop --conflict=rename %h/Phone/Inbox";
      Restart = "on-failure";
      RestartSec = 5;
    };
    Install.WantedBy = [ "default.target" ];
  };

  dconf.settings."org/gnome/desktop/interface".color-scheme = "prefer-dark";
}
