const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

let creatingOffscreenDocument;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification:
        "Capture the active tab's media stream and create a local WebM recording for download."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }

  await creatingOffscreenDocument;
}

async function sendToOffscreen(message) {
  if (!(await hasOffscreenDocument())) {
    throw new Error("The recording document is not available.");
  }

  return chrome.runtime.sendMessage({
    ...message,
    target: "offscreen"
  });
}

async function getRecordingStatus() {
  if (!(await hasOffscreenDocument())) {
    return { ok: true, status: "idle", startedAt: null };
  }

  try {
    const response = await sendToOffscreen({ type: "GET_STATUS" });
    return response || { ok: true, status: "idle", startedAt: null };
  } catch (error) {
    return { ok: true, status: "idle", startedAt: null };
  }
}

async function startRecording() {
  const current = await getRecordingStatus();
  if (["starting", "recording", "stopping", "saving"].includes(current.status)) {
    return {
      ok: false,
      error: "A recording is already active or being saved."
    };
  }

  // Create the offscreen consumer before issuing the short-lived stream ID.
  await ensureOffscreenDocument();

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (!activeTab || typeof activeTab.id !== "number") {
      throw new Error("Could not identify the active tab. Try opening the extension on the tab you want to record.");
    }

    // This call is made in response to the user opening and using the extension popup.
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: activeTab.id
    });

    const response = await sendToOffscreen({
      type: "START_CAPTURE",
      streamId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "The tab capture could not be started.");
    }

    return response;
  } catch (error) {
    // Do not leave an unused offscreen document open after a failed start.
    await closeOffscreenDocument().catch(() => {});
    throw error;
  }
}

async function stopRecording() {
  if (!(await hasOffscreenDocument())) {
    return { ok: false, error: "There is no active recording." };
  }

  return sendToOffscreen({ type: "STOP_CAPTURE" });
}

async function startBlobDownload(message, sender) {
  if (sender.url !== OFFSCREEN_URL) {
    throw new Error("Only the recording document can request a recording download.");
  }

  if (typeof message.url !== "string" || !message.url.startsWith("blob:")) {
    throw new Error("The recording file URL is invalid.");
  }

  if (typeof message.filename !== "string" || !message.filename.endsWith(".webm")) {
    throw new Error("The recording filename is invalid.");
  }

  const downloadId = await chrome.downloads.download({
    url: message.url,
    filename: message.filename,
    saveAs: false,
    conflictAction: "uniquify"
  });

  const [item] = await chrome.downloads.search({ id: downloadId });
  return {
    ok: true,
    downloadId,
    state: item?.state || "in_progress"
  };
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

function broadcastStatus(message) {
  chrome.runtime.sendMessage({
    target: "popup",
    type: "STATUS_UPDATE",
    status: message.status,
    startedAt: message.startedAt ?? null,
    error: message.error || null,
    captureInfo: message.captureInfo || null
  }).catch(() => {
    // The popup is commonly closed while a recording is in progress.
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "START_RECORDING") {
    startRecording()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    stopRecording()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "GET_STATUS") {
    getRecordingStatus()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, status: "error", error: error.message || String(error) }));
    return true;
  }

  if (message.type === "DOWNLOAD_BLOB") {
    startBlobDownload(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "CHECK_DOWNLOAD") {
    chrome.downloads.search({ id: message.downloadId })
      .then((items) => sendResponse({ ok: true, state: items[0]?.state || "unknown" }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "RECORDING_STATUS" && sender.url === OFFSCREEN_URL) {
    broadcastStatus(message);
    return;
  }

  if (message.type === "CLOSE_OFFSCREEN" && sender.url === OFFSCREEN_URL) {
    closeOffscreenDocument().catch((error) => {
      console.error("Could not close the offscreen document:", error);
    });
    return;
  }
});

// Keep the offscreen page alive until Chrome has finished reading its Blob URL.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;

  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "DOWNLOAD_STATE_CHANGED",
    downloadId: delta.id,
    state
  }).catch(() => {
    // No recording document is expected for unrelated downloads.
  });
});
