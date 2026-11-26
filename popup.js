const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const timerElement = document.getElementById("timer");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const detailText = document.getElementById("detailText");
const captureDetails = document.getElementById("captureDetails");

let currentStatus = "idle";
let recordingStartedAt = null;
let timerInterval = null;
let currentCaptureInfo = null;

const STATUS_LABELS = {
  idle: "Ready",
  starting: "Starting…",
  recording: "Recording",
  stopping: "Stopping…",
  saving: "Preparing download…",
  saved: "Saved",
  error: "Recording error"
};

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function refreshTimer() {
  if (!recordingStartedAt) {
    timerElement.textContent = "00:00";
    return;
  }
  timerElement.textContent = formatElapsed(Date.now() - recordingStartedAt);
}

function formatBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond)) return "unknown bitrate";
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps target`;
}

function updateCaptureDetails() {
  if (!currentCaptureInfo) {
    captureDetails.textContent = currentStatus === "starting"
      ? "Detecting captured dimensions…"
      : "Capture size: detected when recording starts";
    return;
  }

  const { width, height, videoBitrate } = currentCaptureInfo;
  const size = width && height ? `${width} × ${height}` : "dimensions unavailable";
  captureDetails.textContent = `Captured: ${size} · ${formatBitrate(videoBitrate)}`;
}

function setStatus(status, options = {}) {
  currentStatus = status;
  if (options.captureInfo) currentCaptureInfo = options.captureInfo;
  if (status === "idle") currentCaptureInfo = null;
  updateCaptureDetails();

  if (["idle", "saved", "error"].includes(status)) {
    recordingStartedAt = null;
  } else if (typeof options.startedAt === "number") {
    recordingStartedAt = options.startedAt;
  }

  statusText.textContent = STATUS_LABELS[status] || status;
  statusDot.className = `status-dot ${status}`.trim();

  const isRecording = status === "recording";
  const isBusy = ["starting", "stopping", "saving"].includes(status);
  startButton.disabled = isRecording || isBusy;
  stopButton.disabled = !isRecording;

  if (status === "starting") {
    detailText.textContent = "Requesting access to the active tab…";
  } else if (status === "recording") {
    detailText.textContent = "Recording continues while you browse or close this popup.";
  } else if (status === "stopping") {
    detailText.textContent = "Finalizing the WebM recording…";
  } else if (status === "saving") {
    detailText.textContent = "Saving the file to your Downloads folder…";
  } else if (status === "saved") {
    detailText.textContent = options.error || "Your WebM file is in the Downloads folder.";
  } else if (status === "error") {
    detailText.textContent = options.error || "The recording could not be completed. See the extension error details.";
  } else {
    detailText.textContent = "Start recording the currently active tab.";
  }

  if (isRecording && recordingStartedAt) {
    refreshTimer();
    if (!timerInterval) timerInterval = window.setInterval(refreshTimer, 250);
  } else {
    if (timerInterval) {
      window.clearInterval(timerInterval);
      timerInterval = null;
    }
    refreshTimer();
  }
}

async function refreshFromBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!response?.ok) {
      setStatus("error", { error: response?.error || "Could not read recording status." });
      return;
    }

    setStatus(response.status || "idle", {
      startedAt: response.startedAt,
      captureInfo: response.captureInfo || null,
      error: response.error || null
    });
  } catch (error) {
    setStatus("idle");
  }
}

startButton.addEventListener("click", async () => {
  setStatus("starting");
  startButton.disabled = true;
  detailText.textContent = "Connecting to the active tab…";

  try {
    const response = await chrome.runtime.sendMessage({ type: "START_RECORDING" });
    if (!response?.ok) {
      setStatus("error", { error: response?.error || "Could not start recording." });
      return;
    }

    setStatus("recording", { startedAt: response.startedAt, captureInfo: response.captureInfo || null });
  } catch (error) {
    setStatus("error", { error: error.message || String(error) });
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  detailText.textContent = "Stopping the capture and preparing your WebM file…";

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    if (!response?.ok) {
      setStatus("error", { error: response?.error || "Could not stop the recording." });
      return;
    }
    setStatus("stopping", { startedAt: recordingStartedAt });
  } catch (error) {
    setStatus("error", { error: error.message || String(error) });
  }
});

async function refreshShortcutHint() {
  const hint = document.getElementById("shortcutHint");
  if (!hint) return;
  try {
    const commands = await chrome.commands.getAll();
    const toggle = commands.find((command) => command.name === "toggle-recording");
    hint.textContent = toggle?.shortcut
      ? `Shortcut: ${toggle.shortcut} starts/stops recording without resizing the tab.`
      : "Set a shortcut at chrome://extensions/shortcuts to start/stop without resizing the tab.";
  } catch (error) {
    hint.textContent = "";
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "popup" || message.type !== "STATUS_UPDATE") return;

  setStatus(message.status || "idle", {
    startedAt: message.startedAt,
    captureInfo: message.captureInfo || null,
    error: message.error || null
  });
});

refreshFromBackground();
refreshShortcutHint();
