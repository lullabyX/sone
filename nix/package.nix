{
  lib,
  rustPlatform,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_11,
  nodejs,
  cargo-tauri,
  pkg-config,
  wrapGAppsHook3,
  webkitgtk_4_1,
  gtk3,
  librsvg,
  openssl,
  glib-networking,
  libsecret,
  alsa-lib,
  libpulseaudio,
  libayatana-appindicator,
  gst_all_1,
  src,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "sone";
  version = (builtins.fromJSON (builtins.readFile ../src-tauri/tauri.conf.json)).version;

  inherit src;

  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";
  cargoLock.lockFile = ../src-tauri/Cargo.lock;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 3;
    # Update when pnpm-lock.yaml changes: set to lib.fakeHash, build, paste the
    # `got: sha256-...` value the build prints.
    hash = "sha256-5Tj9Dp89JCVNBq9H5zfwqZe0wNqfL5fVRrF353HaG28=";
  };

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs
    pnpm_11
    pnpmConfigHook
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    webkitgtk_4_1
    gtk3
    librsvg
    openssl
    glib-networking
    libsecret
    alsa-lib
    libpulseaudio
    libayatana-appindicator
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-libav
  ];

  # The frontend is built by `cargo tauri build` via tauri.conf.json's
  # beforeBuildCommand ("pnpm build"); cargo-tauri.hook then unpacks the
  # bundle (binary, desktop entry, icons, tidal:// scheme) into $out.

  meta = {
    description = "Native Linux client for TIDAL — lossless and bit-perfect audio streaming";
    homepage = "https://github.com/lullabyX/sone";
    license = lib.licenses.gpl3Only;
    mainProgram = "sone";
    platforms = [ "x86_64-linux" ];
  };
})
