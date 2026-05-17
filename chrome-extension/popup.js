// DeepSeek Auth Exporter — Popup Script

function $(id) { return document.getElementById(id); }

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

function buildAuthJson(data) {
  const cookie = [];
  if (data.ds_session_id) cookie.push(`ds_session_id=${data.ds_session_id}`);
  if (data.smidV2) cookie.push(`smidV2=${data.smidV2}`);

  return {
    token: data.token || '',
    hif_dliq: data.hif_dliq || '',
    hif_leim: data.hif_leim || '',
    cookie: cookie.join('; '),
    wasmUrl: WASM_URL,
  };
}

function getStatus(auth, data) {
  const checks = [
    { label: 'token', ok: !!auth.token },
    { label: 'cookie (ds_session_id / smidV2)', ok: auth.cookie.includes('=') },
    { label: 'hif_dliq', ok: !!auth.hif_dliq, optional: true },
    { label: 'hif_leim', ok: !!auth.hif_leim },
  ];
  return { checks, allOk: checks.every((c) => c.ok || c.optional) };
}

function render(data) {
  const auth = buildAuthJson(data);
  const preview = JSON.stringify(auth, null, 2);
  $('jsonPreview').textContent = preview;

  const { checks, allOk } = getStatus(auth, data);
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);

  if (!data._lastUpdated) {
    $('status').className = 'status warn';
    $('status').textContent = '\u26A0\uFE0F No credentials yet. Click "Collect from Tab" while on chat.deepseek.com';
  } else if (allOk) {
    const optionalMissing = checks.filter((c) => !c.ok && c.optional);
    if (optionalMissing.length > 0) {
      $('status').className = 'status warn';
      $('status').textContent = '\u2705 Ready to export (optional: ' + optionalMissing.map((c) => c.label).join(', ') + ' not found)';
    } else {
      $('status').className = 'status ok';
      $('status').textContent = '\u2705 All credentials captured \u2014 ready to export';
    }
  } else {
    $('status').className = 'status warn';
    $('status').textContent = '\u26A0\uFE0F Missing: ' + missing.join(', ');
  }

  $('detail').textContent = data._lastUpdated
    ? 'Last updated: ' + data._lastUpdated
    : 'Open chat.deepseek.com, then click Collect';
}

function loadAuth() {
  chrome.runtime.sendMessage({ action: 'export' }, (response) => {
    if (response && response.success) render(response.auth);
    else {
      $('status').className = 'status err';
      $('status').textContent = '\u274C Failed to read stored credentials';
    }
  });
}

// Collect button — reads cookies + localStorage from active DeepSeek tab
$('btnCollect').addEventListener('click', () => {
  $('status').className = 'status warn';
  $('status').textContent = '\u23F3 Collecting from chat.deepseek.com...';
  chrome.runtime.sendMessage({ action: 'collect' }, (response) => {
    if (response && response.success) {
      render(response.auth);
    } else {
      $('status').className = 'status err';
      $('status').textContent = '\u274C ' + (response?.error || 'Unknown error');
    }
  });
});

// Copy JSON button
$('btnCopy').addEventListener('click', () => {
  const json = $('jsonPreview').textContent;
  navigator.clipboard.writeText(json).then(() => {
    $('btnCopy').textContent = '\u2705 Copied!';
    setTimeout(() => { $('btnCopy').textContent = '\uD83D\uDCCB Copy JSON'; }, 1500);
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
  $('btnSave').textContent = '\u2705 Saved!';
  setTimeout(() => { $('btnSave').textContent = '\uD83D\uDCBE Download File'; }, 1500);
});

// Initial load
loadAuth();
