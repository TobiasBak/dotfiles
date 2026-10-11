{
  description = "NixOS configuration for tobias-serv01";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-wsl = {
      url = "github:nix-community/NixOS-WSL/main";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    hermes-agent = {
      url = "github:NousResearch/hermes-agent";
      # Keep Hermes on its upstream Nixpkgs pin. Its Python runtime needs a
      # newer SQLite than the stable host input currently provides.
    };
    voxtype = {
      # Keep the private repo local so Nix rebuilds do not need GitHub credentials.
      url = "path:/home/tobias/code/voxtype";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      home-manager,
      hermes-agent,
      hunk,
      nixpkgs,
      nixos-wsl,
      voxtype,
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      formatter.${system} = pkgs.nixfmt;

      nixosConfigurations = {
        tobias-serv01 = nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            hermes-agent.nixosModules.default
            ./hosts/tobias-serv01/configuration.nix
          ];
        };
      };
    };
}
