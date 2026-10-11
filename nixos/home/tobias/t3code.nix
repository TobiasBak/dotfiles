{ config, ... }:

# T3 Code's installed per-user service: local unit overrides and its memory
# budget. Free of NixOS options so non-NixOS Home Manager hosts can import it.
{
  home.file.".config/systemd/user/t3code.service.d/local.conf" = {
    source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.dotfiles/configs/t3code/service.conf";
    force = true;
  };

  # One budget for the server and its agents. T3 places agent scopes in
  # app-t3code-agents.slice, which systemd nests here by name, and sets that
  # child slice's own runtime limits itself.
  # PC budget: 30 GiB RAM minus the 8 GiB Windows VM and 6 GiB for the desktop.
  # Reclaim above 12 GiB; contain runaway agent tools at 16 GiB and 1 GiB swap.
  systemd.user.slices.app-t3code = {
    Unit.Description = "T3 Code server and agents";
    Slice = {
      MemoryHigh = "12G";
      MemoryMax = "16G";
      MemorySwapMax = "1G";
    };
  };
}
