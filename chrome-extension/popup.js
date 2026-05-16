// DeepSeek Auth Exporter — Popup Script

function $(id) { return document.getElementById(id); }

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

function buildAuthJson(data) {
  const token = data.token || '';
  const cookie = [];
  if (data.ds_session_id) cookie.push(`ds_session_id=${data.ds_session_id}`);
  if (data.smidV2) cookie.push(`smidV2=${data.smidV2}`);

  return {
    token: token,
    hif_dliq: data['x-hif-dliq'] || data.hif_dliq || '',
    hif_leim: data['x-hif-leim'] || data.hif_leim || '',
    cookie: cookie.join('; '),
    wasmUrl: WASM_URL,
  };
}

function render(data) {
  const auth = buildAuthJson(data);
  const preview = JSON.stringify(auth, null, 2);
  $('jsonPreview').textContent = preview;

  const fields = [
    { label: 'Has token', ok: !!auth.token },
    { label: 'Has cookie (ds_session_id/smidV2)', ok: auth.cookie.includes('=') },
    { label: 'Has x-hif-dliq', ok: !!auth.hif_dliq },
    { label: 'Has x-hif-leim', ok: !!auth.hif_leim },
  ];
  const allOk = fields.every((f) => f.ok);

  if (!data._lastUpdated) {
    $('status').className = 'status warn';
    $('status').textContent = '⚠️ No credentials captured yet. Open chat.deepseek.com and send a message.';
  } else if (allOk) {
    $('status').className = 'status ok';
    $('status').textContent = '✅ All credentials ready — token, cookies, and headers captured';
  } else {
    const missing = fields.filter((f) => !f.ok).map((f) => f.label);
    $('status').className = 'status warn';
    $('status').textContent = `⚠️ Missing: ${missing.join(', ')}`;
  }

  $('detail').textContent = data._lastUpdated
    ? `Last updated: ${data._lastUpdated}`
    : 'Open chat.deepseek.com and send a message to capture headers';
}

function loadAuth() {
  chrome.runtime.sendMessage({ action: 'export' }, (response) => {
    if (response && response.success) {
      render(response.auth);
    } else {
      $('status').className = 'status err';
      $('status').textContent = '❌ Failed to read stored credentials';
    }
  });
}

// Refresh button
$('btnRefresh').addEventListener('click', () => {
  $('status').className = 'status warn';
  $('status').textContent = '⏳ Refreshing from DeepSeek tab...';
  chrome.runtime.sendMessage({ action: 'refresh' }, (response) => {
    if (response && response.success) {
      // Wait a moment for storage to update, then reload
      setTimeout(loadAuth, 500);
    } else {
      $('status').className = 'status err';
      $('status').textContent = '❌ Open chat.deepseek.com in a tab first';
    }
  });
});

// Copy JSON button
$('btnCopy').addEventListener('click', () => {
  const json = $('jsonPreview').textContent;
  navigator.clipboard.writeText(json).then(() => {
    $('btnCopy').textContent = '✅ Copied!';
    $('btnCopy').classList.add('copied');
    setTimeout(() => {
      $('btnCopy').textContent = '📋 Copy JSON';
      $('btnCopy').classList.remove('copied');
    }, 1500);
  });
});

// Download file button
$('btnSave').addEventListener('click', () => {
  const json = $('jsonPreview').textContent;
  const blob = new Blob([json + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deepseek-auth.json';
  a.click();
  URL.revokeObjectURL(url);
  $('btnSave').textContent = '✅ Saved!';
  setTimeout(() => { $('btnSave').textContent = '💾 Download File'; }, 1500);
});

// Initial load
loadAuth();
