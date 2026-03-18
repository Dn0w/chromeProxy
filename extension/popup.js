// popup.js

const dot    = document.getElementById('status-dot');
const txt    = document.getElementById('status-text');
const portRow = document.getElementById('port-row');
const portDisplay = document.getElementById('port-display');
const errBox = document.getElementById('error-box');
const btn    = document.getElementById('toggle-btn');
const logList = document.getElementById('log-list');
const logCount = document.getElementById('log-count');
const openOptions = document.getElementById('open-options');

let state = { running: false, port: 8080, logs: [] };

function renderState(s) {
  state = { ...state, ...s };

  dot.className = 'status-dot ' + (state.running ? 'on' : 'off');
  txt.textContent = state.running
    ? `Proxy active — ${state.bindAddr || '0.0.0.0'}:${state.port}`
    : 'Proxy stopped';

  if (state.running) {
    portRow.style.display = 'flex';
    portDisplay.textContent = `${state.bindAddr || '0.0.0.0'}:${state.port}`;
  } else {
    portRow.style.display = 'none';
  }

  if (state.error) {
    errBox.style.display = 'block';
    errBox.textContent = state.error;
  } else {
    errBox.style.display = 'none';
  }

  btn.disabled = false;
  if (state.running) {
    btn.textContent = 'Stop Proxy';
    btn.className = 'btn stop';
  } else {
    btn.textContent = 'Start Proxy';
    btn.className = 'btn start';
  }
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logList.innerHTML = '<div class="log-empty">No traffic yet</div>';
    logCount.textContent = '0 requests';
    return;
  }
  const recent = logs.slice(0, 12);
  logCount.textContent = logs.length + ' requests';
  logList.innerHTML = recent.map(e => {
    const method = (e.method || 'REQ').toUpperCase();
    const cls = ['GET','POST','PUT','DELETE','CONNECT','ERROR'].includes(method) ? method : 'other';
    const host = e.host || e.message || '';
    return `<div class="log-entry">
      <span class="log-method ${cls}">${method}</span>
      <span class="log-host" title="${host}:${e.port || ''}">${host}</span>
    </div>`;
  }).join('');
}

// Initial load
chrome.runtime.sendMessage({ type: 'getState' }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp) {
    renderState(resp);
    renderLogs(resp.logs);
  }
});

// Live updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'stateUpdate') renderState(msg.state);
  if (msg.type === 'newLog') {
    state.logs = [msg.entry, ...state.logs].slice(0, 1000);
    renderLogs(state.logs);
  }
});

// Toggle button
btn.addEventListener('click', () => {
  btn.disabled = true;
  if (state.running) {
    chrome.runtime.sendMessage({ type: 'stopProxy' });
  } else {
    chrome.runtime.sendMessage({ type: 'startProxy', port: state.port });
  }
});

// Open options
openOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
