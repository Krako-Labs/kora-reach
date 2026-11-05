import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "KORA Reach Live Screen", version: "0.2.0" });
const button = document.getElementById("toggle");
const status = document.getElementById("status");
const img = document.getElementById("screen");
const empty = document.getElementById("empty");

let watching = false;
let inflight = false;
let timer = null;
let frames = 0;
let connected = false;

function setStatus(text) { status.textContent = text; }
function stop() {
  watching = false;
  if (timer) { clearTimeout(timer); timer = null; }
  button.textContent = "Start viewing";
  setStatus(connected ? "Stopped" : "Disconnected");
}
async function nextFrame() {
  if (!watching || inflight) return;
  inflight = true;
  try {
    const result = await app.callServerTool({ name: "computer_live_frame", arguments: {} });
    if (result.isError) throw new Error((result.content || []).filter(x=>x.type==="text").map(x=>x.text).join(" ") || "Screen access denied");
    const frame = (result.content || []).find(x => x.type === "image");
    if (!frame || !frame.data) throw new Error("No screen frame returned");
    img.src = "data:" + (frame.mimeType || "image/png") + ";base64," + frame.data;
    img.style.display = "block";
    empty.style.display = "none";
    frames += 1;
    setStatus("Live · " + frames + " frames (1.5s interval)");
  } catch (error) {
    stop();
    setStatus("Viewer error: " + String(error?.message || error));
  } finally {
    inflight = false;
    if (watching) timer = setTimeout(nextFrame, 1500);
  }
}
button.addEventListener("click", () => {
  if (watching) { stop(); return; }
  watching = true;
  frames = 0;
  button.textContent = "Stop viewing";
  setStatus("Connecting to Mac...");
  void nextFrame();
});
window.addEventListener("pagehide", stop);

void app.connect().then(() => {
  connected = true;
  button.disabled = false;
  setStatus("Ready · Screen Recording permission required");
}).catch(error => {
  setStatus("Could not connect: " + String(error?.message || error));
});
