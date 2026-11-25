# Local Tab Recorder (Chrome MV3)

A personal, local Chrome extension that records audio and video from the currently active Chrome tab and saves a timestamped `.webm` file in the browser's Downloads folder.

## Requirements

- Google Chrome 116 or newer.
- The tab you want to record must be active when you start recording.
- Enough local browser storage and free disk space for the recording.

## Install

1. Extract `local-tab-recorder.zip` to a folder on your computer.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the extracted `local-tab-recorder` folder (the folder that contains `manifest.json`).
6. Pin **Local Tab Recorder** from Chrome's Extensions menu for convenient access.

## Record

1. Open the tab you are allowed to record (for example, a video you are watching).
2. Click the Local Tab Recorder toolbar icon.
3. Click **Start Recording**. Recording continues if you close the popup.
4. Reopen the extension popup to view the elapsed time and reported capture dimensions.
5. Click **Stop & Save** when finished.
6. Find `tab-capture-YYYY-MM-DD-HHMM.webm` in your Downloads folder.

## Resolution and bitrate behavior

The extension reads the dimensions reported by the captured tab video track and selects a target video bitrate:

| Reported captured dimensions | Target video bitrate |
|---|---:|
| Up to 1280 × 720 | 2.5 Mbps |
| Above 720p up to 1920 × 1080 | 6 Mbps |
| Above 1080p up to 2560 × 1440 | 10 Mbps |
| Above 1440p | 16 Mbps |

Audio target bitrate is 128 kbps. The popup reports the captured track dimensions and the MediaRecorder video bitrate selected by the browser.

**Important:** This extension records the tab's captured/rendered output. It does not force YouTube to stream at 1080p, and it cannot create detail that was not present in the captured frames. The reported capture dimensions can be lower than the video's selected YouTube quality when the browser window or tab capture surface is smaller. For the best chance of capturing 1920 × 1080, use a sufficiently large display/window and maximize the browser before starting. The reported dimensions are the dimensions the capture track exposes to this extension.

## Storage and performance

- MediaRecorder emits chunks every 5 seconds.
- Each chunk is written sequentially to the extension's Origin Private File System (OPFS) while recording. The complete session is not accumulated in a JavaScript array in RAM.
- When recording stops, the completed local file is handed to Chrome's Downloads API. The temporary OPFS file is removed after the download completes or is interrupted.
- The popup warns users to keep sessions relatively short (under 30–45 minutes). Disk-backed chunk writing reduces whole-recording RAM usage, but long sessions still use disk space and keep the video encoder active. Browser/device limits, storage quota, thermal conditions, and available free space can still affect reliability.
- At a 6 Mbps video target plus 128 kbps audio, a 30-minute recording is roughly 1.38 GB before container overhead and bitrate variation. Ensure adequate free disk space.

## Other notes

- Manifest V3 service worker plus an offscreen document.
- `chrome.tabCapture.getMediaStreamId()` obtains the active tab capture stream.
- The extension prefers `video/webm;codecs=vp8,opus`, falling back to `video/webm` if needed.
- Captured tab audio is routed back to the default audio output so you can continue hearing the tab.
- The extension does not upload recordings to a server.
- DRM-protected or otherwise restricted content may appear black or may not be capturable. The extension does not bypass content protection.
- Use the extension only for content you own or are authorized to record, and follow the site's terms and applicable law.

## Files

- `manifest.json` — MV3 manifest and minimum extension permissions.
- `background.js` — service worker, active-tab stream ID, download handling, and offscreen lifecycle.
- `offscreen.html` / `offscreen.js` — MediaStream, audio passthrough, MediaRecorder, OPFS chunk writing, and WebM download handoff.
- `popup.html` / `popup.css` / `popup.js` — controls, timer, capture dimensions, bitrate display, and recording warning.
