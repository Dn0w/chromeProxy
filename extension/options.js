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
const hostDot         = document.getElementById('host-dot');
const hostStatusText  = document.getElementById('host-status-text');
const installBtn      = document.getElementById('install-btn');
const uninstallBtn    = document.getElementById('uninstall-btn');
const installSteps    = document.getElementById('install-steps');
const uninstallSteps  = document.getElementById('uninstall-steps');
const cmdText         = document.getElementById('cmd-text');
const copyCmdBtn      = document.getElementById('copy-cmd-btn');
const uninstallCmdText = document.getElementById('uninstall-cmd-text');
const copyUninstallBtn = document.getElementById('copy-uninstall-btn');
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
    else if (method === 'CONNECT') statusClass = 'status-tun';

    const host = escHtml(e.host || e.message || '');
    const path = escHtml(e.path || '');
    const port = e.port || '';
    const ts   = e.timestamp || '';

    return `<tr>
      <td class="td-time">${escHtml(ts)}</td>
      <td><span class="method-badge m-${mClass}">${method}</span></td>
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
  // state: 'ok' | 'missing' | 'error' | 'checking'
  hostDot.className = 'host-dot' + (state !== 'checking' ? ' ' + state : '');
  const labels = { ok: 'Installed ✓', missing: 'Not installed', error: 'Error', checking: 'Checking…' };
  hostStatusText.textContent = labels[state] || state;
  installBtn.style.display  = state === 'ok' ? 'none' : 'block';
  uninstallBtn.style.display = state === 'ok' ? 'block' : 'none';
  if (state === 'ok') {
    installSteps.style.display = 'none';
  }
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

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/x-python' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

// Detect platform for showing the right run command
const _plat   = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
const _isWin  = _plat.includes('win');

function runCmd(filename) {
  if (_isWin) return 'python "%USERPROFILE%\\Downloads\\' + filename + '"';
  return 'python3 ~/Downloads/' + filename;
}

installBtn.addEventListener('click', async () => {
  const extId  = chrome.runtime.id;
  const pyCode = await fetch(chrome.runtime.getURL('native_host/proxy_host.py')).then(r => r.text());

  // Base64-encode proxy code — avoids ALL string-escaping conflicts
  const bytes  = new TextEncoder().encode(pyCode);
  let   bin    = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  const pyB64  = btoa(bin);

  // Generate a self-contained cross-platform Python installer.
  // Rules: no Python f-strings, no \r\n literals → zero escaping conflicts
  //        with the JS template literal.
  //   SEP  = chr(92)          — backslash, for Windows registry paths
  //   CRLF = chr(13)+chr(10)  — Windows line-ending in the .bat wrapper
  const script = [
    '#!/usr/bin/env python3',
    '"""Chrome Proxy - Cross-Platform Native Host Installer',
    'Extension: ' + extId,
    '',
    'Linux/macOS : python3 chrome-proxy-install.py',
    'Windows     : python  chrome-proxy-install.py',
    '"""',
    'import sys, os, json, stat, platform, base64',
    '',
    'EXT_ID    = "' + extId + '"',
    'HOST_NAME = "com.chromeproxy.host"',
    'SEP       = chr(92)',          // backslash — no escape needed
    'CRLF      = chr(13) + chr(10)', // \r\n — no escape needed
    '',
    '_CODE      = b"' + pyB64 + '"',
    'PROXY_CODE = base64.b64decode(_CODE).decode("utf-8")',
    '',
    'def install_dir():',
    '    s = platform.system()',
    '    if s == "Windows":',
    '        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ChromeProxy")',
    '    return os.path.expanduser("~/.local/share/chrome-proxy")',
    '',
    'def nm_dirs():',
    '    s = platform.system()',
    '    if s == "Darwin":',
    '        base = os.path.expanduser("~/Library/Application Support")',
    '        return [',
    '            ("Chrome",   os.path.join(base, "Google/Chrome/NativeMessagingHosts")),',
    '            ("Chromium", os.path.join(base, "Chromium/NativeMessagingHosts")),',
    '            ("Edge",     os.path.join(base, "Microsoft Edge/NativeMessagingHosts")),',
    '        ]',
    '    return [',
    '        ("Chrome",   os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts")),',
    '        ("Chromium", os.path.expanduser("~/.config/chromium/NativeMessagingHosts")),',
    '    ]',
    '',
    'def main():',
    '    s = platform.system()',
    '    d = install_dir()',
    '    os.makedirs(d, exist_ok=True)',
    '',
    '    py = os.path.join(d, "proxy_host.py")',
    '    with open(py, "w", encoding="utf-8") as f:',
    '        f.write(PROXY_CODE)',
    '    if s != "Windows":',
    '        os.chmod(py, os.stat(py).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)',
    '',
    '    if s == "Windows":',
    '        bat = os.path.join(d, "proxy_host.bat")',
    '        with open(bat, "w") as f:',
    '            f.write("@echo off" + CRLF)',
    '            f.write(\'"\' + sys.executable + \'"\' + " " + \'"\' + py + \'"\' + " %*" + CRLF)',
    '        host_exec = bat',
    '    else:',
    '        host_exec = py',
    '',
    '    manifest = {',
    '        "name": HOST_NAME,',
    '        "description": "Chrome Proxy Native Host",',
    '        "path": host_exec,',
    '        "type": "stdio",',
    '        "allowed_origins": ["chrome-extension://" + EXT_ID + "/"]',
    '    }',
    '',
    '    if s == "Windows":',
    '        _install_windows(manifest, d)',
    '    else:',
    '        for browser, nm_dir in nm_dirs():',
    '            os.makedirs(nm_dir, exist_ok=True)',
    '            p = os.path.join(nm_dir, HOST_NAME + ".json")',
    '            with open(p, "w") as f:',
    '                json.dump(manifest, f, indent=2)',
    '            print("  " + browser + ": " + p)',
    '',
    '    print("")',
    '    print("  Installed : " + host_exec)',
    '    print("  Extension : " + EXT_ID)',
    '    print("")',
    '    print("  Done! Return to the extension and click Start Proxy.")',
    '    print("")',
    '',
    'def _install_windows(manifest, d):',
    '    import winreg',
    '    mp = os.path.join(d, HOST_NAME + ".json")',
    '    with open(mp, "w") as f:',
    '        json.dump(manifest, f, indent=2)',
    '    for parts in [',
    '        ["SOFTWARE", "Google", "Chrome", "NativeMessagingHosts", HOST_NAME],',
    '        ["SOFTWARE", "Chromium", "NativeMessagingHosts", HOST_NAME],',
    '        ["SOFTWARE", "Microsoft", "Edge", "NativeMessagingHosts", HOST_NAME],',
    '    ]:',
    '        rk = SEP.join(parts)',
    '        try:',
    '            k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, rk)',
    '            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, mp)',
    '            winreg.CloseKey(k)',
    '            print("  Registry: HKCU" + SEP + rk)',
    '        except Exception as e:',
    '            print("  Warning: " + str(e))',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ].join('\n');

  downloadFile('chrome-proxy-install.py', script);

  const cmd = runCmd('chrome-proxy-install.py');
  cmdText.textContent = cmd;
  installSteps.style.display = 'flex';
  makeCopyBtn(copyCmdBtn, cmd);
});

uninstallBtn.addEventListener('click', async () => {
  const script = [
    '#!/usr/bin/env python3',
    '"""Chrome Proxy - Native Host Uninstaller"""',
    'import os, platform, shutil',
    '',
    'HOST_NAME = "com.chromeproxy.host"',
    'SEP       = chr(92)',
    '',
    'def install_dir():',
    '    s = platform.system()',
    '    if s == "Windows":',
    '        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ChromeProxy")',
    '    return os.path.expanduser("~/.local/share/chrome-proxy")',
    '',
    'def nm_dirs():',
    '    s = platform.system()',
    '    if s == "Darwin":',
    '        base = os.path.expanduser("~/Library/Application Support")',
    '        return [',
    '            os.path.join(base, "Google/Chrome/NativeMessagingHosts"),',
    '            os.path.join(base, "Chromium/NativeMessagingHosts"),',
    '            os.path.join(base, "Microsoft Edge/NativeMessagingHosts"),',
    '        ]',
    '    return [',
    '        os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts"),',
    '        os.path.expanduser("~/.config/chromium/NativeMessagingHosts"),',
    '    ]',
    '',
    'def main():',
    '    s = platform.system()',
    '    d = install_dir()',
    '    if os.path.exists(d):',
    '        shutil.rmtree(d)',
    '        print("  Removed: " + d)',
    '    if s == "Windows":',
    '        _uninstall_windows()',
    '    else:',
    '        for nm_dir in nm_dirs():',
    '            p = os.path.join(nm_dir, HOST_NAME + ".json")',
    '            if os.path.exists(p):',
    '                os.remove(p)',
    '                print("  Removed: " + p)',
    '    print("")',
    '    print("  Native host uninstalled.")',
    '    print("")',
    '',
    'def _uninstall_windows():',
    '    import winreg',
    '    for parts in [',
    '        ["SOFTWARE", "Google", "Chrome", "NativeMessagingHosts", HOST_NAME],',
    '        ["SOFTWARE", "Chromium", "NativeMessagingHosts", HOST_NAME],',
    '        ["SOFTWARE", "Microsoft", "Edge", "NativeMessagingHosts", HOST_NAME],',
    '    ]:',
    '        rk = SEP.join(parts)',
    '        try:',
    '            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rk)',
    '            print("  Removed registry: HKCU" + SEP + rk)',
    '        except FileNotFoundError:',
    '            pass',
    '        except Exception as e:',
    '            print("  Warning: " + str(e))',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ].join('\n');

  downloadFile('chrome-proxy-uninstall.py', script);

  const cmd = runCmd('chrome-proxy-uninstall.py');
  uninstallCmdText.textContent = cmd;
  uninstallSteps.style.display = 'flex';
  makeCopyBtn(copyUninstallBtn, cmd);
  setHostStatus('missing');
});

// Check on page load
checkHostStatus();
