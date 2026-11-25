let mediaStream = null;
let mediaRecorder = null;
let audioContext = null;
let audioSource = null;
let recordingStatus = "idle";
let recordingStartedAt = null;
let captureInfo = null;
let currentDownloadUrl = null;
let currentDownloadId = null;
let downloadStateBeforeId = new Map();
let finalizationStarted = false;
let downloadFinalized = false;
let lastError = null;

// Chunks are written sequentially to the extension's Origin Private File System
// (OPFS) instead of retaining the complete recording in a JavaScript array.
let outputFileName = null;
let outputFileHandle = null;
let outputWritable = null;
let outputWriteChain = Promise.resolve();
let outputWriteError = null;

const MIME_TYPE_PREFERENCE = "video/webm;codecs=vp8,opus";
const AUDIO_BITRATE = 128_000;
const RECORDING_TIMESLICE_MS = 5_000;

function sendStatus(status, error = null) {
  recordingStatus = status;
  lastError = error;

  chrome.runtime.sendMessage({
    target: "service-worker",
    type: "RECORDING_STATUS",
    status,
    startedAt: recordingStartedAt,
    captureInfo,
    error
  }).catch(() => {
    // The popup or service worker may not currently be active.
  });
}

function getStatusSnapshot() {
  return {
    ok: true,
    status: recordingStatus,
    startedAt: recordingStartedAt,
    captureInfo,
    error: lastError
  };
}

function createTimestampedFilename() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `tab-capture-${yyyy}-${mm}-${dd}-${hh}${min}.webm`;
}

function chooseVideoBitrate(width, height) {
  if (!width || !height) return 4_000_000;

  const pixels = width * height;
  if (pixels <= 1280 * 720) return 2_500_000;
  if (pixels <= 1920 * 1080) return 6_000_000;
  if (pixels <= 2560 * 1440) return 10_000_000;
  return 16_000_000;
}

function stopTracks() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      try {
        track.stop();
      } catch (error) {
        console.warn("Could not stop a media track:", error);
      }
    }
  }
  mediaStream = null;

  if (audioSource) {
    try {
      audioSource.disconnect();
    } catch (error) {
      // It may already be disconnected.
    }
    audioSource = null;
  }

  if (audioContext) {
    const contextToClose = audioContext;
    audioContext = null;
    contextToClose.close().catch(() => {
      // The context may already be closed.
    });
  }
}

function clearRecorderReferences() {
  if (mediaRecorder) {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onerror = null;
    mediaRecorder.onstop = null;
  }
  mediaRecorder = null;
}

async function createTemporaryOutputFile() {
  if (!navigator.storage?.getDirectory) {
    throw new Error("This Chrome version does not support the local recording storage used by this extension. Update Chrome and try again.");
  }

  const root = await navigator.storage.getDirectory();
  outputFileName = `local-tab-recorder-${Date.now()}-${crypto.randomUUID()}.webm`;
  outputFileHandle = await root.getFileHandle(outputFileName, { create: true });
  outputWritable = await outputFileHandle.createWritable();
  outputWriteChain = Promise.resolve();
  outputWriteError = null;
}

function queueChunkWrite(chunk) {
  outputWriteChain = outputWriteChain.then(async () => {
    if (!outputWritable) {
      throw new Error("The temporary recording file is no longer writable.");
    }
    await outputWritable.write(chunk);
  }).catch((error) => {
    outputWriteError = error;
    lastError = `Could not write a recording chunk to local storage: ${error.message || String(error)}`;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (stopError) {
        console.warn("Could not stop after a storage write failure:", stopError);
      }
    }
  });
}

async function cleanupTemporaryFile() {
  if (outputWritable) {
    const writable = outputWritable;
    outputWritable = null;
    try {
      await writable.abort();
    } catch (error) {
      // It may already be closed or aborted.
    }
  }

  const fileName = outputFileName;
  outputFileName = null;
  outputFileHandle = null;

  if (fileName && navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(fileName);
    } catch (error) {
      // A file already removed or never fully created is harmless.
    }
  }
}

async function startCapture(streamId) {
  if (["starting", "recording", "stopping", "saving"].includes(recordingStatus)) {
    throw new Error("A recording is already active or being saved.");
  }

  finalizationStarted = false;
  downloadFinalized = false;
  lastError = null;
  recordingStartedAt = null;
  captureInfo = null;
  currentDownloadUrl = null;
  currentDownloadId = null;
  downloadStateBeforeId.clear();
  sendStatus("starting");

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      }
    });

    const videoTrack = mediaStream.getVideoTracks()[0];
    const videoSettings = videoTrack?.getSettings?.() || {};
    const width = Number.isFinite(videoSettings.width) ? videoSettings.width : null;
    const height = Number.isFinite(videoSettings.height) ? videoSettings.height : null;
    const requestedVideoBitrate = chooseVideoBitrate(width, height);

    // tabCapture takes tab audio out of the normal output path. Route a copy
    // back to the default output so the user can continue hearing the tab.
    audioContext = new AudioContext();
    try {
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
    } catch (error) {
      console.warn("Could not resume the tab-audio output context:", error);
    }
    audioSource = audioContext.createMediaStreamSource(mediaStream);
    audioSource.connect(audioContext.destination);

    await createTemporaryOutputFile();

    const mimeType = MediaRecorder.isTypeSupported(MIME_TYPE_PREFERENCE)
      ? MIME_TYPE_PREFERENCE
      : "video/webm";

    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType,
      videoBitsPerSecond: requestedVideoBitrate,
      audioBitsPerSecond: AUDIO_BITRATE
    });

    captureInfo = {
      width,
      height,
      videoBitrate: mediaRecorder.videoBitsPerSecond || requestedVideoBitrate,
      audioBitrate: mediaRecorder.audioBitsPerSecond || AUDIO_BITRATE,
      mimeType: mediaRecorder.mimeType || mimeType
    };

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        queueChunkWrite(event.data);
      }
    };

    mediaRecorder.onerror = (event) => {
      const message = event.error?.message || "The browser reported a recording error.";
      lastError = message;
      sendStatus("error", message);

      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch (error) {
          stopTracks();
          clearRecorderReferences();
          cleanupTemporaryFile().catch(() => {});
        }
      } else {
        stopTracks();
        clearRecorderReferences();
        cleanupTemporaryFile().catch(() => {});
      }
    };

    mediaRecorder.onstop = () => {
      finalizeRecording().catch((error) => {
        lastError = error.message || String(error);
        sendStatus("error", lastError);
        stopTracks();
        clearRecorderReferences();
        cleanupTemporaryFile().finally(closeAfterFailure);
      });
    };

    recordingStartedAt = Date.now();
    mediaRecorder.start(RECORDING_TIMESLICE_MS);
    sendStatus("recording");

    return {
      ok: true,
      status: "recording",
      startedAt: recordingStartedAt,
      captureInfo,
      mimeType: captureInfo.mimeType
    };
  } catch (error) {
    stopTracks();
    clearRecorderReferences();
    await cleanupTemporaryFile();
    recordingStartedAt = null;
    captureInfo = null;
    sendStatus("error", error.message || String(error));
    throw error;
  }
}

function requestStop() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    return {
      ok: false,
      status: recordingStatus,
      error: "There is no active recording to stop."
    };
  }

  sendStatus("stopping");
  try {
    mediaRecorder.stop();
    return { ok: true, status: "stopping" };
  } catch (error) {
    const message = error.message || String(error);
    sendStatus("error", message);
    stopTracks();
    clearRecorderReferences();
    cleanupTemporaryFile().finally(closeAfterFailure);
    return { ok: false, status: "error", error: message };
  }
}

async function finalizeRecording() {
  if (finalizationStarted) return;
  finalizationStarted = true;

  // The final dataavailable event is delivered before onstop. Wait for every
  // queued write so the completed file contains all WebM chunks in order.
  stopTracks();
  clearRecorderReferences();
  await outputWriteChain;

  if (outputWriteError) {
    throw new Error(lastError || "A recording chunk could not be saved to local storage.");
  }
  if (!outputWritable || !outputFileHandle) {
    throw new Error("The temporary recording file is unavailable.");
  }

  const writable = outputWritable;
  outputWritable = null;
  await writable.close();

  const webmFile = await outputFileHandle.getFile();
  if (webmFile.size === 0) {
    throw new Error("The resulting WebM file was empty. Try recording a tab that is actively playing audio or video.");
  }

  currentDownloadUrl = URL.createObjectURL(webmFile);
  const filename = createTimestampedFilename();
  sendStatus("saving");

  // Keep the OPFS file and its Blob URL until Chrome finishes the download.
  const result = await chrome.runtime.sendMessage({
    type: "DOWNLOAD_BLOB",
    url: currentDownloadUrl,
    filename
  }).catch((error) => ({ ok: false, error: error.message || String(error) }));

  if (!result?.ok) {
    const link = document.createElement("a");
    link.href = currentDownloadUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();

    sendStatus("saved", result?.error
      ? `Chrome's Downloads API could not start the download; a browser download was attempted instead. ${result.error}`
      : "A browser download was attempted.");

    window.setTimeout(async () => {
      await releaseDownloadResources();
      closeAfterFailure();
    }, 5_000);
    return;
  }

  currentDownloadId = result.downloadId;

  if (result.state === "complete" || result.state === "interrupted") {
    await handleDownloadFinished(result.state);
    return;
  }

  const earlyState = downloadStateBeforeId.get(currentDownloadId);
  if (earlyState) {
    await handleDownloadFinished(earlyState);
    return;
  }

  // Close the race where a very short download completes before its ID is set.
  const stateCheck = await chrome.runtime.sendMessage({
    type: "CHECK_DOWNLOAD",
    downloadId: currentDownloadId
  }).catch(() => null);

  if (stateCheck?.state === "complete" || stateCheck?.state === "interrupted") {
    await handleDownloadFinished(stateCheck.state);
  }
}

async function handleDownloadFinished(state) {
  if (state !== "complete" && state !== "interrupted") return;
  if (downloadFinalized) return;
  downloadFinalized = true;

  const finishedStatus = state === "complete" ? "saved" : "error";
  const finishedError = state === "complete"
    ? null
    : "Chrome reported that the WebM download was interrupted. You can retry from the Downloads page if a partial file remains.";

  sendStatus(finishedStatus, finishedError);
  await releaseDownloadResources();

  // Give the popup time to receive the final status before closing the document.
  window.setTimeout(() => {
    chrome.runtime.sendMessage({ type: "CLOSE_OFFSCREEN" }).catch(() => {});
  }, 250);
}

async function releaseDownloadResources() {
  if (currentDownloadUrl) {
    URL.revokeObjectURL(currentDownloadUrl);
    currentDownloadUrl = null;
  }
  currentDownloadId = null;
  downloadStateBeforeId.clear();
  await cleanupTemporaryFile();
  recordingStartedAt = null;
}

function closeAfterFailure() {
  window.setTimeout(() => {
    chrome.runtime.sendMessage({ type: "CLOSE_OFFSCREEN" }).catch(() => {});
  }, 500);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return;

  if (message.type === "START_CAPTURE") {
    startCapture(message.streamId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "GET_STATUS") {
    sendResponse(getStatusSnapshot());
    return;
  }

  if (message.type === "STOP_CAPTURE") {
    sendResponse(requestStop());
    return;
  }

  if (message.type === "DOWNLOAD_STATE_CHANGED") {
    if (currentDownloadId === message.downloadId) {
      handleDownloadFinished(message.state).catch((error) => {
        console.error("Could not finalize the completed download:", error);
      });
    } else if (currentDownloadId === null && recordingStatus === "saving") {
      downloadStateBeforeId.set(message.downloadId, message.state);
    }
  }
});
