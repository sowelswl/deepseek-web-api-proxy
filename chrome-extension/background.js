// DeepSeek Auth Exporter — Background Service Worker
// Listens for web requests to capture dynamic headers, exposes API for popup.

const STORAGE_KEY = 'deepseek_auth';

// Required header fields
const HEADER_FIELDS = ['x-hif-dliq', 'x-hif-leim'];

// Capture headers from DeepSeek API requests
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const captured = {};
    for (const field of HEADER_FIELDS) {
      const header = details.requestHeaders.find(
        (h) => h.name.toLowerCase() === field
      );
      if (header) captured[field] = header.value;
    }
    if (Object.keys(captured).length > 0) {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const current = result[STORAGE_KEY] || {};
        const updated = { ...current, ...captured };
        chrome.storage.local.set({ [STORAGE_KEY]: updated });
      });
    }
  },
  { urls: ['https://chat.deepseek.com/*'] },
  ['requestHeaders']
);

// Listen for tab updates to trigger cookie extraction
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab.url &&
    tab.url.startsWith('https://chat.deepseek.com')
  ) {
    extractCookies(tabId);
  }
});

// Also when popup requests a refresh
function extractCookies(tabId) {
  // Cookies we need from chat.deepseek.com
  const neededCookies = ['token', 'ds_session_id', 'smidV2'];
  const promises = neededCookies.map(
    (name) =>
      new Promise((resolve) => {
        chrome.cookies.get(
          { url: 'https://chat.deepseek.com', name },
          (cookie) => resolve({ name, value: cookie ? cookie.value : '' })
        );
      })
  );

  Promise.all(promises).then((results) => {
    const cookieMap = {};
    let cookieStr = '';
    for (const { name, value } of results) {
      cookieMap[name] = value;
      if (value) {
        cookieStr += (cookieStr ? '; ' : '') + `${name}=${value}`;
      }
    }

    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const current = result[STORAGE_KEY] || {};
      const updated = {
        ...current,
        ...cookieMap,
        cookie: cookieStr,
        _tabId: tabId,
        _lastUpdated: new Date().toISOString(),
      };
      chrome.storage.local.set({ [STORAGE_KEY]: updated });
    });
  });
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'refresh') {
    // Find an open DeepSeek tab
    chrome.tabs.query(
      { url: 'https://chat.deepseek.com/*' },
      (tabs) => {
        if (tabs.length > 0) {
          extractCookies(tabs[0].id);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No DeepSeek tab open' });
        }
      }
    );
    return true; // Keep channel open for async response
  }

  if (request.action === 'export') {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const auth = result[STORAGE_KEY] || {};
      sendResponse({ success: true, auth });
    });
    return true;
  }
});
