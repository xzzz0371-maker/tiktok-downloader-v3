# TikTok / Douyin Downloader (Chrome Extension)

A **Manifest V3** Chrome extension for downloading **watermark-free videos from TikTok and Douyin**. It combines local request interception, deep parsing, and FetchHTML fallback parsing for high success rates, and supports batch downloads, a side panel mode, and automatic parsing of the recommendation feed.

## 🌐 Web Version (Online)

Prefer a quick online tool without installing the extension? Try the **web version**:

**https://tiktok-downloader-av8.pages.dev/**

- No installation required — works in any browser, on any device
- Paste **one link at a time** to download a single watermark-free video
- Includes a built-in comparison of the web version vs. the extension

> The extension is still recommended for the best experience (batch downloads, auto-parse, local-interception parsing, keyboard shortcut, download history, etc.).

## ✨ Features

- **100% free, no limits**: no trial, no activation code, no daily download limit — unlimited downloads for everyone
- **Watermark-free downloads** for TikTok and Douyin videos
- **Multi-layer parsing**: local interception + deep parsing + FetchHTML fallback to maximize success rate
- **Batch parsing**: paste multiple links (one per line) or parse all videos on the current page at once
- **Download all**: download every parsed video in one click, with a "skip already downloaded" option
- **Live download progress** with speed and percentage display
- **Auto-parse on the recommendation feed**: videos are collected automatically as you scroll (toggleable)
- **Side panel mode**: use the extension as a persistent panel on the right side of the browser
- **Floating window mode**: keep the popup open in its own always-on-top window while you browse
- **Video preview**: click any result to preview the video with title and author info
- **Download history**: track downloaded videos, with export and clear options
- **Keyboard shortcut**: `Ctrl+Shift+D` (Mac: `Command+Shift+D`) to download the video on the current page
- **Context menu**: right-click on a video page to trigger a download
- **Theme toggle**: switch between dark and light themes

## 📦 Installation

1. Download the source code and extract it to a local folder (or `git clone` this repository).
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the project folder.
5. Once installed, click the extension icon in the toolbar to start using it.

## 🚀 Usage

- **Download the current video**: open a TikTok / Douyin video page, click the extension icon → click **Current Page**, or press `Ctrl+Shift+D`.
- **Batch download**: copy multiple video links (one per line), paste them into the input box → click **Parse** → click **Download All**.
- **Browse and download**: click the **📋** button for side panel mode, or the **📌** button for a floating window.
- **Auto-parse on the feed**: enable "Auto-parse recommendation feed" to collect videos automatically while scrolling.

## ⌨️ Keyboard Shortcut

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+D` (Mac: `Command+Shift+D`) | Download the video on the current page |

## 🛠️ Technical Details

- Built on Chrome **Manifest V3**
- Uses a Service Worker as the background script with ES Module support
- Permissions: `downloads`, `storage`, `tabs`, `scripting`, `contextMenus`, `notifications`, `webRequest`, `sidePanel`

## ⚠️ Disclaimer

This project is for personal learning and technical exchange only. Please comply with the terms of service of TikTok / Douyin and applicable local laws and regulations, respect the copyright of original creators, and do not use it for commercial purposes or any infringing activity.
