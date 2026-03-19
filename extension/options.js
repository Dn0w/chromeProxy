// options.js — Settings & Full Log page

const dot           = document.getElementById('status-dot');
const badge         = document.getElementById('status-badge');
const toggle        = document.getElementById('proxy-toggle');
const toggleLbl     = document.getElementById('toggle-label');
const bindAddrInput  = document.getElementById('bind-addr-input');
const applyBindBtn   = document.getElementById('apply-bind-addr');
const stealthToggle  = document.getElementById('stealth-toggle');
const stealthLabel   = document.getElementById('stealth-label');
const portInput     = document.getElementById('port-input');
const applyBtn      = document.getElementById('apply-port');
const howtoAddr     = document.getElementById('howto-addr');
const howtoPort     = document.getElementById('howto-port');
const errBox        = document.getElementById('error-box');

// Native host elements
const hostDot        = document.getElementById('host-dot');
const hostStatusText = document.getElementById('host-status-text');
const installBtn     = document.getElementById('install-btn');
const installSteps   = document.getElementById('install-steps');
const cmdText        = document.getElementById('cmd-text');
const copyCmdBtn     = document.getElementById('copy-cmd-btn');

// CA certificate elements
const caBadge   = document.getElementById('ca-badge');
const caDlBtn   = document.getElementById('ca-dl-btn');
const caSteps   = document.getElementById('ca-steps');
const caStepLbl = document.getElementById('ca-step-label');
const caCmdText = document.getElementById('ca-cmd-text');
const caCopyBtn = document.getElementById('ca-copy-btn');
const logBody       = document.getElementById('log-body');
const logWrap       = document.getElementById('log-wrap');
const logStats      = document.getElementById('log-stats');
const filterStats   = document.getElementById('filter-stats');
const filterInput   = document.getElementById('filter-input');
const methodFilter  = document.getElementById('method-filter');
const autoscrollChk = document.getElementById('autoscroll');
const clearBtn      = document.getElementById('clear-btn');

let allLogs = [];
let filteredLogs = [];

// ── State rendering ───────────────────────────────────────────────────────────

function applyState(s) {
  const on = s.running;
  dot.className = 'brand-dot' + (on ? ' on' : '');
  badge.textContent = on ? `Active — ${s.bindAddr || '0.0.0.0'}:${s.port}` : 'Stopped';
  badge.className = 'status-badge' + (on ? ' active' : '');

  toggle.checked = on;
  toggleLbl.textContent = on ? 'On' : 'Off';

  portInput.value = s.port || 8080;
  bindAddrInput.value = s.bindAddr || '0.0.0.0';
  stealthToggle.checked = !!s.stealth;
  stealthLabel.textContent = s.stealth ? 'On' : 'Off';
  updateCA(!!s.caReady);
  updateHowto(s.bindAddr || '0.0.0.0', s.port || 8080);

  if (s.error) {
    errBox.style.display = 'block';
    errBox.textContent = '⚠ ' + s.error;
  } else {
    errBox.style.display = 'none';
  }

  if (s.logs) {
    allLogs = s.logs;
    applyFilter();
  }
}

function updateCA(caReady) {
  caBadge.textContent = caReady ? 'Ready' : 'Not installed';
  caBadge.className   = 'ca-status-badge ' + (caReady ? 'ready' : 'missing');
}

function caInstallCmd(filename) {
  if (_isWin)  return `certutil -addstore -user Root "%USERPROFILE%\\Downloads\\${filename}"`;
  if (_isMac)  return `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/Downloads/${filename}`;
  // Linux — Chrome/Chromium via NSS
  return `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Chrome Proxy CA" -i ~/Downloads/${filename}`;
}

function caInstallLabel() {
  if (_isWin) return 'Run in Command Prompt (as Administrator):';
  if (_isMac) return 'Run in Terminal:';
  return 'Run in Terminal (requires libnss3-tools):';
}

function doCADownload(pem) {
  const fname = 'chrome-proxy-ca.crt';
  const blob  = new Blob([pem], { type: 'application/x-x509-ca-cert' });
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = fname;
  a.click();
  URL.revokeObjectURL(a.href);
  const cmd = caInstallCmd(fname);
  caStepLbl.textContent = caInstallLabel();
  caCmdText.textContent = cmd;
  caSteps.style.display = 'flex';
  makeCopyBtn(caCopyBtn, cmd);
}

function pollForCAPEM(attempts) {
  if (attempts <= 0) {
    caDlBtn.textContent = 'Download CA Certificate';
    caDlBtn.disabled = false;
    errBox.style.display = 'block';
    errBox.textContent = '⚠ Could not reach native host. Make sure it is installed.';
    return;
  }
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    if (resp && resp.caPEM) {
      caDlBtn.textContent = 'Download CA Certificate';
      caDlBtn.disabled = false;
      doCADownload(resp.caPEM);
    } else {
      setTimeout(() => pollForCAPEM(attempts - 1), 600);
    }
  });
}

caDlBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    const pem = resp && resp.caPEM;
    if (pem) {
      doCADownload(pem);
    } else {
      caDlBtn.textContent = 'Connecting…';
      caDlBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'connectNative' }, () => {
        pollForCAPEM(10); // poll up to 10 × 600ms = 6 seconds
      });
    }
  });
});

function updateHowto(addr, port) {
  // If bound to 0.0.0.0 show 127.0.0.1 as the connect address
  howtoAddr.textContent = (addr === '0.0.0.0' || addr === '::') ? '127.0.0.1' : addr;
  howtoPort.textContent = port;
}

// ── Filtering & rendering logs ────────────────────────────────────────────────

function applyFilter() {
  const hostFilter = filterInput.value.trim().toLowerCase();
  const mFilter = methodFilter.value;

  filteredLogs = allLogs.filter(e => {
    if (mFilter && e.method !== mFilter) return false;
    if (hostFilter && !(e.host || '').toLowerCase().includes(hostFilter) &&
        !(e.message || '').toLowerCase().includes(hostFilter)) return false;
    return true;
  });

  renderLogs();
  updateStats();
}

function renderLogs() {
  if (allLogs.length === 0) {
    logBody.innerHTML = '<tr class="empty-row"><td colspan="6">No traffic captured yet. Start the proxy and route traffic through it.</td></tr>';
    return;
  }
  if (filteredLogs.length === 0) {
    logBody.innerHTML = '<tr class="empty-row"><td colspan="6">No entries match the current filter.</td></tr>';
    return;
  }

  logBody.innerHTML = filteredLogs.map(e => {
    const method = (e.method || 'REQ').toUpperCase();
    const mClass = ['GET','POST','PUT','DELETE','CONNECT','ERROR'].includes(method) ? method : 'other';
    const status = e.status || '';
    let statusClass = 'status-ok';
    if (status.startsWith('error') || method === 'ERROR') statusClass = 'status-err';
    else if (status === 'stealth') statusClass = 'status-stealth';
    else if (method === 'CONNECT') statusClass = 'status-tun';

    const host    = escHtml(e.host || e.message || '');
    const path    = escHtml(e.path || '');
    const port    = e.port || '';
    const ts      = e.timestamp || '';
    const srcHost = escHtml(e.src_host || '');
    const srcPort = e.src_port || '';

    return `<tr>
      <td class="td-time">${escHtml(ts)}</td>
      <td><span class="method-badge m-${mClass}">${method}</span></td>
      <td class="td-host" title="${srcHost}">${srcHost}</td>
      <td class="td-port">${srcPort}</td>
      <td class="td-host" title="${host}">${host}</td>
      <td class="td-port">${port}</td>
      <td class="td-path" title="${path}">${path}</td>
      <td class="${statusClass}">${escHtml(status)}</td>
    </tr>`;
  }).join('');

  if (autoscrollChk.checked) logWrap.scrollTop = logWrap.scrollHeight;
}

function updateStats() {
  logStats.textContent = allLogs.length + ' total requests';
  filterStats.textContent = filteredLogs.length !== allLogs.length ? filteredLogs.length + ' shown' : '';
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Controls ──────────────────────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  if (toggle.checked) {
    chrome.runtime.sendMessage({
      type: 'startProxy',
      port: parseInt(portInput.value) || 8080,
      bindAddr: bindAddrInput.value.trim() || '0.0.0.0',
      stealth: stealthToggle.checked
    });
  } else {
    chrome.runtime.sendMessage({ type: 'stopProxy' });
  }
});

stealthToggle.addEventListener('change', () => {
  stealthLabel.textContent = stealthToggle.checked ? 'On' : 'Off';
  chrome.runtime.sendMessage({ type: 'updateStealth', stealth: stealthToggle.checked });
});

applyBindBtn.addEventListener('click', () => {
  const addr = bindAddrInput.value.trim();
  if (!addr) { alert('Please enter a valid IP address or 0.0.0.0'); return; }
  chrome.runtime.sendMessage({ type: 'updateBindAddr', bindAddr: addr });
  updateHowto(addr, parseInt(portInput.value) || 8080);
});

applyBtn.addEventListener('click', () => {
  const p = parseInt(portInput.value);
  if (!p || p < 1024 || p > 65535) { alert('Port must be between 1024 and 65535'); return; }
  chrome.runtime.sendMessage({ type: 'updatePort', port: p });
  updateHowto(bindAddrInput.value.trim() || '0.0.0.0', p);
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearLogs' }, () => {
    allLogs = [];
    filteredLogs = [];
    renderLogs();
    updateStats();
  });
});

filterInput.addEventListener('input', applyFilter);
methodFilter.addEventListener('change', applyFilter);

// ── Live updates ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'stateUpdate') applyState(msg.state);
  if (msg.type === 'newLog') {
    allLogs.unshift(msg.entry);
    if (allLogs.length > 1000) allLogs.length = 1000;
    applyFilter();
  }
});

// ── Initial load ──────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
  if (chrome.runtime.lastError) {
    errBox.style.display = 'block';
    errBox.textContent = 'Could not connect to background service. Reload the extension.';
    return;
  }
  if (resp) applyState(resp);
});

// ── Native host install / uninstall ──────────────────────────────────────────

function setHostStatus(state) {
  hostDot.className = 'host-dot' + (state !== 'checking' ? ' ' + state : '');
  const labels = { ok: 'Installed ✓', missing: 'Not installed', error: 'Error', checking: 'Checking…' };
  hostStatusText.textContent = labels[state] || state;
  installBtn.style.display = state === 'ok' ? 'none' : 'block';
  if (state === 'ok') installSteps.style.display = 'none';
}

// Detect host status: try connecting via background; if error message contains
// "not found" or "cannot find" the host manifest is missing.
function checkHostStatus() {
  setHostStatus('checking');
  chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
    if (chrome.runtime.lastError || !resp) { setHostStatus('error'); return; }
    if (resp.error && /not found|cannot find|native/i.test(resp.error)) {
      setHostStatus('missing');
    } else if (resp.running || !resp.error) {
      // Successfully connected (or no error yet — try a ping)
      chrome.runtime.sendMessage({ type: 'pingNative' }, (r) => {
        if (chrome.runtime.lastError) { setHostStatus('missing'); return; }
        setHostStatus(r && r.ok ? 'ok' : 'missing');
      });
    } else {
      setHostStatus('missing');
    }
  });
}

function makeCopyBtn(btn, text) {
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  });
}

// Detect platform
const _plat      = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
const _isWin     = _plat.includes('win');
const _isMac     = _plat.includes('mac');
const _isArm     = navigator.userAgentData?.architecture === 'arm' ||
                   navigator.platform?.toLowerCase().includes('arm');

function binaryName() {
  if (_isWin)  return 'chrome-proxy-windows-amd64.exe';
  if (_isMac)  return _isArm ? 'chrome-proxy-darwin-arm64' : 'chrome-proxy-darwin-amd64';
  return 'chrome-proxy-linux-amd64';
}

function installCmd(filename, extId) {
  if (_isWin) return `"${filename}" --install ${extId}`;
  return `chmod +x ~/Downloads/${filename} && ~/Downloads/${filename} --install ${extId}`;
}

installBtn.addEventListener('click', async () => {
  const extId = chrome.runtime.id;
  const fname = binaryName();
  const url   = chrome.runtime.getURL('native_host/' + fname);

  // Download the binary
  const resp  = await fetch(url);
  const buf   = await resp.arrayBuffer();
  const blob  = new Blob([buf], { type: 'application/octet-stream' });
  const a     = document.createElement('a');
  a.href      = URL.createObjectURL(blob);
  a.download  = fname;
  a.click();
  URL.revokeObjectURL(a.href);

  const cmd = installCmd(fname, extId);
  cmdText.textContent = cmd;
  installSteps.style.display = 'flex';
  makeCopyBtn(copyCmdBtn, cmd);
});


// Check on page load
checkHostStatus();
