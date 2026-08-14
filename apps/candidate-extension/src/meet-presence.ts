function reportPresence() {
  if (document.visibilityState === "visible" && document.hasFocus()) {
    void chrome.runtime.sendMessage({ type: "AUTHENTI8_MEET_ACTIVE" });
  }
}

window.addEventListener("focus", reportPresence);
document.addEventListener("visibilitychange", reportPresence);
setInterval(reportPresence, 5_000);
reportPresence();
