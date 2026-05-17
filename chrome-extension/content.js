// DeepSeek Auth Exporter — Content Script
// Runs on chat.deepseek.com to read localStorage values.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'readLocalStorage') {
    const data = {};
    const keys = request.keys || [];
    for (const key of keys) {
      try {
        data[key] = localStorage.getItem(key) || '';
      } catch (e) {
        data[key] = '';
      }
    }
    // Also dump all keys for debugging
    if (request.dumpAll) {
      data._allKeys = Object.keys(localStorage);
    }
    sendResponse({ data });
  }
});
