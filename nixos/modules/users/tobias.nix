{ pkgs, ... }:

{
  users.users.tobias = {
    isNormalUser = true;
    description = "Tobias";
    home = "/home/tobias";
    shell = pkgs.zsh;
    extraGroups = [ "wheel" ];
  };
}
