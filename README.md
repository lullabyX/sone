<div align="center">
  <img src="sone.png" alt="SONE" width="150">
  <h1>SONE</h1>
  <p>The native desktop client for <a href="https://tidal.com">TIDAL</a> on Linux. Lossless streaming with bit-perfect ALSA output up to 24-bit/192kHz — your DAC, not your browser's resampler.</p>

  [![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
  [![Platform: Linux](https://img.shields.io/badge/Platform-Linux-yellow.svg)]()
  [![Built with Tauri 2](https://img.shields.io/badge/Built_with-Tauri_2-orange.svg)](https://v2.tauri.app/)
</div>

> [!IMPORTANT]
> Requires an active [TIDAL](https://tidal.com) subscription. Not affiliated with TIDAL.

<!-- TODO: Add a hero screenshot showcasing a custom theme (e.g. Cyberpunk or Midnight Cyan) with the now-playing drawer open -->

<details>
<summary>Table of Contents</summary>

- [Features](#features)
- [Why SONE?](#why-sone)
- [Installation](#installation)
- [Usage](#usage)
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

- **Familiar interface** — a modern UI inspired by the streaming apps you already use
- **Direct hardware access** — GStreamer talks directly to your audio hardware. Lock your DAC to the exact source format, bypassing the system mixer
- **Lightweight** — built with Tauri and Rust. Small binary, low memory footprint
- **Encrypted at rest** — credentials, cache, and settings are encrypted with AES-256-GCM
- **No telemetry, no tracking** — fully open source under GPL-3.0. Your listening data stays on your machine

## Installation

### Download

Pre-built packages for Ubuntu/Debian (.deb), Fedora (.rpm), and a portable AppImage will be available on the [GitHub Releases](https://github.com/lullabyX/sone/releases) page.

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

## Usage

1. Launch the app
2. Enter your Client ID (and optionally Client Secret for Hi-Res — see details below)
3. Click **Get Login Code** and enter the displayed code at [link.tidal.com](https://link.tidal.com)
4. Your library loads automatically — browse and play

<details>
<summary>What are Client ID and Client Secret?</summary>

They are OAuth application credentials used to connect to TIDAL's API. Official TIDAL apps (Android, iOS, desktop) have these built in. Since SONE is an unofficial client, it does not ship with any credentials — you provide your own.

SONE requires credentials from a **native TIDAL application** (such as the Android or desktop client). Credentials from the [TIDAL Developer Portal](https://developer.tidal.com/) (`developer.tidal.com`) **will not work** — those are for TIDAL's public catalog API, which is a different system that does not support authentication or streaming.

SONE does not provide or endorse any specific method for obtaining credentials. You may find guidance by searching online.

**Do I need both?** No. There are two login methods:

- **Device Code** — works with Client ID alone (CD-quality lossless, 16-bit/44.1kHz). Adding Client Secret unlocks Hi-Res up to 24-bit/192kHz.
- **PKCE** — requires both Client ID and Client Secret. Supports Hi-Res up to 24-bit/192kHz.

**Are my credentials safe?** Client ID and Client Secret identify an application, not your personal account. Your TIDAL login is handled separately through TIDAL's standard OAuth 2.0 flow — the same mechanism used by all official TIDAL applications. Credentials are stored locally (encrypted at rest with AES-256-GCM) and only sent to TIDAL's authentication servers.

</details>

<details>
<summary>Troubleshooting</summary>

**No sound?**
Make sure GStreamer plugins are installed — you need at minimum `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad`, and `gstreamer1.0-libav` (or your distro's equivalents).

**"Device busy" error in exclusive mode?**
Another application has exclusive control of the ALSA device. Close it, or select a different output device in the settings menu.

**Playback errors in exclusive/bit-perfect mode?**
Your DAC must natively support the source sample rate. If the hardware doesn't support 192kHz, exclusive mode will fail for Hi-Res streams. Try a lower quality tier or switch to normal output mode.

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
