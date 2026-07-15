# Bootstrap placeholder. Replace this entire file with the output from
# `nixos-generate-config --root /mnt` before installing this host.
{ lib, ... }:

{
  boot.initrd.availableKernelModules = [
    "xhci_pci"
    "nvme"
    "ahci"
    "usb_storage"
    "sd_mod"
  ];

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  warnings = [
    "tobias-stationary is using its bootstrap hardware configuration; replace hosts/tobias-stationary/hardware-configuration.nix before installation"
  ];
}
