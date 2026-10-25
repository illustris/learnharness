{
	description = "LearnHarness - an agent harness for learning";

	inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

	outputs =
		{ self, nixpkgs }:
		let
			systems = [
				"x86_64-linux"
				"aarch64-linux"
			];
			forEachSystem = nixpkgs.lib.genAttrs systems;
			pkgsFor = forEachSystem (system: import nixpkgs { inherit system; });

			version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

			mkPackage =
				pkgs:
				pkgs.buildNpmPackage {
					pname = "learnharness";
					inherit version;

					# Keep build outputs and nix-only files out of the source so
					# editing packaging does not invalidate the npm build.
					src = pkgs.lib.cleanSourceWith {
						src = ./.;
						filter =
							path: _type:
							!(builtins.elem (baseNameOf path) [
								".next"
								"node_modules"
								"dist"
								"result"
								"flake.nix"
								"flake.lock"
								"learnharness-server.sh"
							]);
						name = "learnharness-source";
					};

					nodejs = pkgs.nodejs_26;
					npmDepsHash = "sha256-Sc41l0dUM/R6LV8/DNbbSsgq6gKB4nI2Utf5vqvY84M=";
					npmFlags = [ "--ignore-scripts" ];

					env.NEXT_TELEMETRY_DISABLED = "1";

					# next/font/google downloads fonts at build time; swap to
					# next/font/local with the vendored woff2 files (same latin
					# subsets) so the build is hermetic. See nix/fonts/.
					postPatch = ''
						substituteInPlace app/layout.tsx \
							--replace-fail \
								'import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";' \
								'import localFont from "next/font/local";' \
							--replace-fail \
								'const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });' \
								'const ui = localFont({ src: [{ path: "../nix/fonts/JetBrainsMono-latin.woff2" }, { path: "../nix/fonts/JetBrainsMono-latin-ext.woff2" }], variable: "--font-jetbrains" });' \
							--replace-fail \
								'const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });' \
								'const prose = localFont({ src: [{ path: "../nix/fonts/SourceSans3-latin.woff2" }, { path: "../nix/fonts/SourceSans3-latin-ext.woff2" }], variable: "--font-sans3" });'
					'';

					# `npm run build` (next build) runs via npmBuildHook. build-server.mjs
					# then copies public/ and .next/static into the standalone tree and
					# refuses to continue if data/ or dev secrets were traced in.
					postBuild = ''
						node scripts/build-server.mjs
					'';

					installPhase = ''
						runHook preInstall

						mkdir -p $out/lib/learnharness
						cp -r .next/standalone/. $out/lib/learnharness/

						mkdir -p $out/bin
						substitute ${./learnharness-server.sh} $out/bin/learnharness-server \
							--replace-fail '@node@' '${pkgs.nodejs_26}/bin/node' \
							--replace-fail '@out@' "$out"
						chmod +x $out/bin/learnharness-server

						runHook postInstall
					'';

					meta = {
						description = "An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph";
						homepage = "https://github.com/amosblomqvist/learnharness";
						license = pkgs.lib.licenses.agpl3Only;
						mainProgram = "learnharness-server";
						platforms = systems;
					};
				};
		in
		{
			packages = forEachSystem (system: {
				default = self.packages.${system}.learnharness;
				learnharness = mkPackage pkgsFor.${system};
			});

			devShells = forEachSystem (system: {
				default = pkgsFor.${system}.mkShell {
					packages = [ pkgsFor.${system}.nodejs_26 ];
					NEXT_TELEMETRY_DISABLED = "1";
				};
			});

			checks = forEachSystem (
				system:
				let
					pkgs = pkgsFor.${system};
					pkg = self.packages.${system}.learnharness;
				in
				{
					# Boot the packaged server against a throwaway data dir and prove
					# the page and one of its static chunks both answer 200.
					server-boots =
						pkgs.runCommand "learnharness-server-boots"
							{
								nativeBuildInputs = [
									pkg
									pkgs.curl.bin
									pkgs.gnugrep
								];
							}
							''
								export LH_DATA_DIR=$(mktemp -d)
								export LH_AUTH_FILE=$(mktemp -d)/auth.json
								export HOME=$(mktemp -d)
								PORT=3111 learnharness-server &
								pid=$!
								trap 'kill $pid 2>/dev/null || true' EXIT
								for i in $(seq 1 60); do
									if curl -sf -o page.html http://127.0.0.1:3111/; then
										chunk=$(grep -oE '/_next/static/[^"]+\.js' page.html | head -n1)
										echo "fetching $chunk"
										curl -sf -o /dev/null "http://127.0.0.1:3111$chunk"
										touch $out
										exit 0
									fi
									sleep 0.5
								done
								echo "server never answered on :3111"
								exit 1
							'';
				}
			);
		};
}
