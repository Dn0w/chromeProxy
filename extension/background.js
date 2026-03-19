// background.js — Service Worker for Chrome Proxy Extension

const NATIVE_HOST = 'com.chromeproxy.host';
const MAX_LOGS = 1000;

let nativePort = null;
let proxyState = {
  running: false,
  port: 8080,
  bindAddr: '0.0.0.0',
  stealth: false,
  caReady: false,
  caPEM: '',
  logs: [],
  error: null
};

// ── Native messaging ─────────────────────────────────────────────────────────

function connectNative() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      if (proxyState.running) {
        proxyState.running = false;
        proxyState.error = err ? err.message : 'Native host disconnected';
        broadcastState();
      }
    });
    // Ask for current status
    nativePort.postMessage({ command: 'getStatus' });
  } catch (e) {
    proxyState.error = 'Failed to connect native host: ' + e.message;
    broadcastState();
  }
}

function handleNativeMessage(msg) {
  if (msg.type === 'status') {
    proxyState.running = msg.running;
    if (msg.port) proxyState.port = msg.port;
    if (msg.bindAddr) proxyState.bindAddr = msg.bindAddr;
    if (msg.stealth !== undefined) proxyState.stealth = msg.stealth;
    if (msg.caReady !== undefined) proxyState.caReady = msg.caReady;
    if (msg.caPEM) proxyState.caPEM = msg.caPEM;
    proxyState.error = msg.error || null;
    broadcastState();
  } else if (msg.type === 'log') {
    addLog(msg);
  } else if (msg.type === 'error') {
    addLog({ type: 'error', method: 'ERROR', host: msg.message, port: '', path: '', status: 'error', timestamp: nowTime() });
  }
}

function addLog(entry) {
  proxyState.logs.unshift(entry);
  if (proxyState.logs.length > MAX_LOGS) proxyState.logs.length = MAX_LOGS;
  chrome.runtime.sendMessage({ type: 'newLog', entry }).catch(() => {});
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: sanitizedState() }).catch(() => {});
}

function sanitizedState() {
  // Don't send full logs in broadcast — popup/options fetch them on demand
  return { running: proxyState.running, port: proxyState.port, bindAddr: proxyState.bindAddr, stealth: proxyState.stealth, caReady: proxyState.caReady, caPEM: proxyState.caPEM, error: proxyState.error };
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

// ── Message handler (from popup / options) ───────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'getState':
      sendResponse({ ...sanitizedState(), logs: proxyState.logs });
      return true;

    case 'startProxy':
      proxyState.port = msg.port || proxyState.port;
      proxyState.bindAddr = msg.bindAddr || proxyState.bindAddr;
      if (msg.stealth !== undefined) proxyState.stealth = msg.stealth;
      chrome.storage.local.set({ port: proxyState.port, bindAddr: proxyState.bindAddr, stealth: proxyState.stealth, enabled: true });
      connectNative();
      if (nativePort) nativePort.postMessage({ command: 'start', port: proxyState.port, bindAddr: proxyState.bindAddr, stealth: proxyState.stealth });
      break;

    case 'stopProxy':
      chrome.storage.local.set({ enabled: false });
      if (nativePort) nativePort.postMessage({ command: 'stop' });
      break;

    case 'updatePort':
      proxyState.port = msg.port;
      chrome.storage.local.set({ port: msg.port });
      if (proxyState.running && nativePort) {
        nativePort.postMessage({ command: 'start', port: msg.port, bindAddr: proxyState.bindAddr });
      }
      break;

    case 'updateBindAddr':
      proxyState.bindAddr = msg.bindAddr;
      chrome.storage.local.set({ bindAddr: msg.bindAddr });
      if (proxyState.running && nativePort) {
        nativePort.postMessage({ command: 'start', port: proxyState.port, bindAddr: msg.bindAddr, stealth: proxyState.stealth });
      }
      break;

    case 'updateStealth':
      proxyState.stealth = msg.stealth;
      chrome.storage.local.set({ stealth: msg.stealth });
      if (proxyState.running && nativePort) {
        nativePort.postMessage({ command: 'start', port: proxyState.port, bindAddr: proxyState.bindAddr, stealth: msg.stealth });
      }
      break;

    case 'connectNative':
      connectNative();
      sendResponse({ ok: true });
      return true;

    case 'clearLogs':
      proxyState.logs = [];
      sendResponse({ ok: true });
      break;

    case 'pingNative':
      if (nativePort) { sendResponse({ ok: true }); return true; }
      try {
        const testPort = chrome.runtime.connectNative(NATIVE_HOST);
        let done = false;
        // Got a reply → host is alive
        testPort.onMessage.addListener(() => {
          if (done) return;
          done = true;
          testPort.disconnect();
          sendResponse({ ok: true });
        });
        // Disconnected before reply → host missing or errored
        testPort.onDisconnect.addListener(() => {
          if (done) return;
          done = true;
          const e = chrome.runtime.lastError;
          sendResponse({ ok: false, error: e ? e.message : 'disconnected' });
        });
        testPort.postMessage({ command: 'getStatus' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
  }
});

// ── Startup & keep-alive ─────────────────────────────────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Reconnect if we should be running but lost the connection
    chrome.storage.local.get(['enabled'], (r) => {
      if (r.enabled && !nativePort) connectNative();
    });
  }
});

// Restore state on service worker startup
chrome.storage.local.get(['port', 'bindAddr', 'stealth', 'enabled'], (r) => {
  if (r.port) proxyState.port = r.port;
  if (r.bindAddr) proxyState.bindAddr = r.bindAddr;
  if (r.stealth !== undefined) proxyState.stealth = r.stealth;
  if (r.enabled) {
    connectNative();
    if (nativePort) nativePort.postMessage({ command: 'start', port: proxyState.port, bindAddr: proxyState.bindAddr, stealth: proxyState.stealth });
  }
});
