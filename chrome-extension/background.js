// DeepSeek Auth Exporter — Background Service Worker
// Reads cookies from Chrome, forwards content-script localStorage data.

const STORAGE_KEY = 'deepseek_auth';

function extractTokenValue(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return parsed.value || '';
  } catch (e) {
    return raw;
  }
}

// Read all needed cookies from chat.deepseek.com
async function readCookies() {
  const needed = ['ds_session_id', 'smidV2'];
  const results = {};
  for (const name of needed) {
    const cookie = await new Promise((resolve) =>
      chrome.cookies.get({ url: 'https://chat.deepseek.com', name }, resolve)
    );
    results[name] = cookie ? cookie.value : '';
  }

  // Build cookie header string
  const parts = [];
  if (results.ds_session_id) parts.push(`ds_session_id=${results.ds_session_id}`);
  if (results.smidV2) parts.push(`smidV2=${results.smidV2}`);
  results.cookie = parts.join('; ');

  return results;
}

// Read localStorage values via content script injection
async function readLocalStorage(tabId) {
  const keys = ['hif_dliq_cached', 'hif_leim_cached', 'userToken'];
  try {
    const results = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { action: 'readLocalStorage', keys, dumpAll: true },
        (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
          else resolve(response.data || {});
        }
      );
    });
    console.log('[DS Auth] readLocalStorage results:', JSON.stringify(results));
    if (results._allKeys) {
      console.log('[DS Auth] All localStorage keys:', JSON.stringify(results._allKeys));
    }
    return results;
  } catch (e) {
    console.warn('[DS Auth] readLocalStorage failed:', e);
    return {};
  }
}

// Find an open DeepSeek tab
function findDeepSeekTab() {
  return new Promise((resolve) => {
    chrome.tabs.query(
      { url: 'https://chat.deepseek.com/*' },
      (tabs) => resolve(tabs.length > 0 ? tabs[0] : null)
    );
  });
}

async function collectAndStore(tabId) {
  const cookies = await readCookies();
  let ls = {};
  if (tabId) ls = await readLocalStorage(tabId);

  const merged = {
    token: cookies.token || ls.userToken ? extractTokenValue(ls.userToken) : '',
    ds_session_id: cookies.ds_session_id || '',
    smidV2: cookies.smidV2 || '',
    cookie: cookies.cookie || '',
    hif_dliq: ls.hif_dliq_cached || '',
    hif_leim: ls.hif_leim_cached || '',
    _lastUpdated: new Date().toISOString(),
  };

  await new Promise((resolve) =>
    chrome.storage.local.set({ [STORAGE_KEY]: merged }, resolve)
  );
  return merged;
}

// Message handler — popup requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collect') {
    findDeepSeekTab().then(async (tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No DeepSeek tab open' });
        return;
      }
      const auth = await collectAndStore(tab.id);
      sendResponse({ success: true, auth });
    });
    return true; // keep channel open for async
  }

  if (request.action === 'export') {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      sendResponse({ success: true, auth: result[STORAGE_KEY] || {} });
    });
    return true;
  }
});
