{
  description = "SONE — native Linux client for TIDAL (lossless, bit-perfect)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      packages.${system} = {
        sone = pkgs.callPackage ./nix/package.nix { src = self; };
        default = self.packages.${system}.sone;
      };

      apps.${system}.default = {
        type = "app";
        program = "${self.packages.${system}.sone}/bin/sone";
      };

      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ self.packages.${system}.sone ];
        packages = [
          pkgs.nodejs
          pkgs.pnpm_11
          pkgs.cargo
          pkgs.rustc
          pkgs.cargo-tauri
        ];
        shellHook = ''
          export GST_PLUGIN_SYSTEM_PATH_1_0="${
            pkgs.lib.makeSearchPath "lib/gstreamer-1.0" [
              pkgs.gst_all_1.gstreamer
              pkgs.gst_all_1.gst-plugins-base
              pkgs.gst_all_1.gst-plugins-good
              pkgs.gst_all_1.gst-plugins-bad
              pkgs.gst_all_1.gst-libav
            ]
          }"
        '';
      };

      formatter.${system} = pkgs.nixfmt;

      checks.${system}.build = self.packages.${system}.sone;
    };
}
