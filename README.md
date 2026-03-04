<div align="center">
  <img src="sone.png" alt="SONE" width="150">
  <h1>SONE</h1>
  <p>The native desktop client for <a href="https://tidal.com">TIDAL</a> on Linux. Lossless streaming with bit-perfect ALSA output up to 24-bit/192kHz (MAX) — your DAC, not your browser's resampler.</p>

  [![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
  [![Platform: Linux](https://img.shields.io/badge/Platform-Linux-yellow.svg)]()
  [![Built with Tauri 2](https://img.shields.io/badge/Built_with-Tauri_2-orange.svg)](https://v2.tauri.app/)

  <a href="https://flathub.org/apps/io.github.lullabyX.sone">
    <img width="200" alt="Download on Flathub" src="https://flathub.org/api/badge?locale=en"/>
  </a>
</div>

> [!IMPORTANT]
> Requires an active [TIDAL](https://tidal.com) subscription. Not affiliated with TIDAL.

https://github.com/user-attachments/assets/67d7a8ed-352b-4ce6-8b9c-70b7427a5f22

<p align="center">
  <img src="data/sone_homepage_readme.png" width="32%" alt="SONE Linux TIDAL client — home page with lossless streaming library" />
  <img src="data/sone_drawer_readme.png" width="32%" alt="SONE now playing drawer — Hi-Res FLAC playback with synced lyrics" />
  <img src="data/sone_theme_readme.png" width="32%" alt="SONE custom theme — native Linux music player with full color customization" />
</p>

<details>
<summary>Table of Contents</summary>

- [Features](#features)
- [Why SONE?](#why-sone)
- [Installation](#installation)
- [Usage](#usage)
- [FAQ](#faq)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

</details>

## Features

### Audio

- **Lossless FLAC and MQA streaming** up to Hi-Res (24-bit/192kHz) with automatic quality fallback
- **Bit-perfect output** — no resampling, no dithering. Your DAC receives the unaltered decoded signal
- **Exclusive ALSA** — bypasses PipeWire/PulseAudio entirely for direct hardware access
- **Volume normalization** (ReplayGain) with automatic context switching between album and track gain
- **Autoplay** — discovers and plays similar tracks when your queue ends

### Interface

- **Custom themes** — 9 presets and a full color picker for accent and background
- **Lyrics** — synced lyrics display for supported tracks
- **Queue persistence** — picks up where you left off across restarts
- **MPRIS integration** — media keys, desktop taskbar widgets, and system media controls
- **System tray** with playback controls and minimize-to-tray
- **Keyboard shortcuts** for all common actions with a built-in shortcut overlay

## Why SONE?

SONE is a lightweight, native alternative to the official TIDAL web player and Electron-based unofficial clients.

- **Full audio quality** — browsers and Electron apps downsample audio to 48kHz before it leaves the application. SONE is native — it outputs at the source's original sample rate, up to 192kHz (TIDAL's max). Exclusive ALSA mode bypasses the system mixer entirely for bit-perfect output to your DAC.
- **Familiar interface** — a modern UI inspired by the streaming apps you already use
- **Direct hardware access** — GStreamer talks directly to your audio hardware. Lock your DAC to the exact source format, bypassing the system mixer
- **Lightweight** — built with Tauri and Rust. Small binary, low memory footprint
- **Encrypted at rest** — credentials, cache, and settings are encrypted with AES-256-GCM
- **No telemetry, no tracking** — fully open source under GPL-3.0. Your listening data stays on your machine

## Installation / Download

### OS Packages

Pre-built packages for Ubuntu/Debian (.deb), Fedora (.rpm), openSUSE (.rpm), and Arch Linux (PKGBUILD) are available on the [GitHub Releases](https://github.com/lullabyX/sone/releases) page.

<p align="center">
  <a href="https://github.com/lullabyX/sone/releases/latest">
    <img src="https://img.shields.io/badge/Debian%20/%20Ubuntu-.deb-A81D33?style=for-the-badge&logo=debian" height="60" alt="Download SONE .deb package for Debian and Ubuntu" />
  </a>
  <a href="https://github.com/lullabyX/sone/releases/latest">
    <img src="https://img.shields.io/badge/Fedora-.rpm-51A2DA?style=for-the-badge&logo=fedora" height="60" alt="Download SONE .rpm package for Fedora Linux" />
  </a>
  <a href="https://github.com/lullabyX/sone/releases/latest">
    <img src="https://img.shields.io/badge/openSUSE-.rpm-73BA25?style=for-the-badge&logo=opensuse" height="60" alt="Download SONE .rpm package for openSUSE Linux" />
  </a>
  <a href="https://github.com/lullabyX/sone/releases/latest">
    <img src="https://img.shields.io/badge/Arch%20Linux-PKGBUILD-1793D1?style=for-the-badge&logo=archlinux" height="60" alt="Download SONE PKGBUILD for Arch Linux and Manjaro" />
  </a>
  <a href="https://aur.archlinux.org/packages/sone-bin">
    <img src="https://img.shields.io/badge/AUR-sone--bin-1793D1?style=for-the-badge&logo=archlinux" height="60" alt="Install SONE from AUR" />
  </a>
</p>

### Flathub
SONE is also officially available on Flathub, making it easy to install on any Linux distribution. You can install it via your software center or by using the CLI:
  
**Install the application**
```
flatpak install flathub io.github.lullabyX.sone
```

**Run the application**
```
flatpak run io.github.lullabyX.sone
```

<a href="https://flathub.org/apps/io.github.lullabyX.sone">
  <img width="200" alt="Download on Flathub" src="https://flathub.org/api/badge?locale=en"/>
</a>

### Building from source

**Rust:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

**Node.js** 18+ (via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), or your preferred method)

**System dependencies:**

<details>
<summary>Ubuntu / Debian</summary>

```bash
sudo apt install -y \
    build-essential curl wget file patchelf \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav \
    libsecret-1-dev
```

Optional (for exclusive ALSA output):

```bash
sudo apt install -y gstreamer1.0-alsa
```
</details>

<details>
<summary>Fedora</summary>

```bash
sudo dnf install -y \
    gcc gcc-c++ make curl wget file patchelf \
    webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel openssl-devel \
    gstreamer1-devel gstreamer1-plugins-base-devel \
    gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav \
    libsecret-devel
```

Optional (for exclusive ALSA output):

```bash
sudo dnf install -y gstreamer1-plugins-base-tools
```
</details>

<details>
<summary>Arch Linux</summary>

#### AUR

SONE is available on the [AUR](https://aur.archlinux.org/packages/sone-bin) as `sone-bin` — a pre-built binary package, no compilation required.

**Install with your AUR helper:**
```bash
yay -S sone-bin
# or
paru -S sone-bin
```

#### Manual Install

```bash
sudo pacman -S --needed \
    base-devel curl wget file patchelf \
    webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg openssl \
    gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav \
    libsecret
```

Optional (for exclusive ALSA output):

```bash
sudo pacman -S --needed gst-plugin-pipewire alsa-plugins
```
</details>

**Build and run:**

```bash
git clone https://github.com/lullabyX/sone.git
cd sone
npm install
npm run tauri dev          # Development mode
npm run tauri build        # Release build (produces .deb, .rpm, .AppImage)
```

**Using build scripts:**

Docker-based build scripts are provided in `build-scripts/build/` to produce distro-specific packages in isolated environments. Requires Docker.

```bash
./build-scripts/build/all.sh              # Build all packages in parallel (deb, rpm, pacman)
./build-scripts/build/deb.sh              # Build .deb only (Ubuntu 22.04)
./build-scripts/build/rpm.sh              # Build .rpm only (Fedora)
./build-scripts/build/pacman.sh           # Build pacman package only (Arch)
./build-scripts/build/all.sh --omit rpm   # Build all except rpm
```

Output goes to `dist/<format>/`. Pass `--no-cache` to force a clean Docker build.

## Usage

1. Launch the app
2. Click **Get Login Code**. You'll be automatically redirected to the official [link.tidal.com](https://link.tidal.com) to login and approve the code. Optionally, you can scan the **QR Code** to login via your mobile device.
3. Your library loads automatically — browse and play!

> [!NOTE]
> **NVIDIA GPU users:** If you see a blank window, rendering glitches, or a Wayland protocol error on launch, start the app with:
> ```bash
> WEBKIT_DISABLE_COMPOSITING_MODE=1 sone
> ```

<details>
<summary>Troubleshooting</summary>

**No sound?**
Make sure GStreamer plugins are installed — you need at minimum `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad`, and `gstreamer1.0-libav` (or your distro's equivalents).

**Playback errors in exclusive/bit-perfect mode?**
Your DAC must natively support the source sample rate. If the hardware doesn't support 192kHz, exclusive mode will fail for Hi-Res streams. Try a lower quality tier or switch to normal output mode.

**"Error 71 (Protocol error) dispatching to Wayland display" on launch?**
This is a known WebKitGTK/Wayland issue affecting Tauri apps on systems with NVIDIA GPUs ([tauri-apps/tauri#10702](https://github.com/tauri-apps/tauri/issues/10702)). As a workaround, launch SONE with the DMA-BUF renderer disabled:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 sone
```

If you're using X11 or don't have an NVIDIA GPU but still see this error, try updating your WebKitGTK and graphics drivers to the latest versions.

**Blank window or rendering glitches on NVIDIA?**
If the app launches but shows a blank/white window or has visual artifacts, try disabling WebKit's compositing mode:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 sone
```

This is a known issue with NVIDIA's proprietary drivers and WebKitGTK hardware acceleration.

</details>

## FAQ

<details>
<summary>I'm getting a "Device busy" error in exclusive or bit-perfect mode</summary>

Your system's sound server (PulseAudio or PipeWire) or another application is already using the ALSA device. Exclusive and bit-perfect modes need direct hardware access — only one application can hold the device at a time.

To fix this, either close the other application using the device, or select a different output device in SONE's settings.

</details>

<details>
<summary>What is the difference between exclusive mode and bit-perfect mode?</summary>

Both bypass your system's sound server (PulseAudio/PipeWire) and write directly to the ALSA hardware device. The difference is in how much processing happens before audio reaches your DAC.

**Exclusive mode** locks the ALSA device so no other application can use it. Audio is converted to a fixed format (32-bit integer, stereo) while preserving the source's native sample rate — no resampling occurs. You still have software volume control and volume normalization (ReplayGain).

**Bit-perfect mode** goes a step further. There is zero processing — no format conversion, no resampling, no volume control. The decoded audio reaches your DAC exactly as it was encoded. The volume slider is locked at 100% and disabled. This is the mode to use if you want the purest signal path to your DAC.

In short: exclusive gives you direct hardware access with volume control. Bit-perfect gives you a completely unaltered signal.

</details>

## Tech Stack

- **Backend:** Rust ([Tauri 2](https://v2.tauri.app/))
- **Frontend:** React 19, Tailwind 4, Jotai
- **Audio:** [GStreamer](https://gstreamer.freedesktop.org/)
- **Config:** `~/.config/sone/`

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/lullabyX/sone). To set up a development environment, follow the [Building from source](#building-from-source) instructions.

If you enjoy using SONE, consider giving the project a star to help others find it.

## Disclaimer

SONE is an independent, community-driven project. It is **not affiliated with, endorsed by, or connected to TIDAL** in any way. All content is streamed directly from TIDAL's service and requires a valid paid subscription. SONE is a streaming client only — it does not support offline downloads, and does not redistribute or circumvent protection of any content.

All trademarks belong to their respective owners.

## License

[GPL-3.0-only](LICENSE)

---

**TL;DR** — SONE is an open-source, native Linux desktop client for TIDAL built with Tauri 2 and Rust. It streams lossless FLAC and Hi-Res audio up to 24-bit/192kHz, with exclusive ALSA output that bypasses PulseAudio and PipeWire entirely for bit-perfect playback directly to your DAC. Lightweight, encrypted at rest, and fully offline — no telemetry, no tracking.
