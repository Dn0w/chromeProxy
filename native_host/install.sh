#!/usr/bin/env bash
# install.sh — Install the Chrome Proxy native messaging host
#
# Usage:
#   ./install.sh <EXTENSION_ID>
#
# Where EXTENSION_ID is the ID shown on chrome://extensions after loading
# the unpacked extension (e.g. "abcdefghijklmnopabcdefghijklmnop").

set -euo pipefail

EXTENSION_ID="${1:-}"
if [[ -z "$EXTENSION_ID" ]]; then
  echo ""
  echo "  Usage: $0 <EXTENSION_ID>"
  echo ""
  echo "  1. Open Chrome and go to chrome://extensions"
  echo "  2. Enable 'Developer mode' (top-right toggle)"
  echo "  3. Click 'Load unpacked' and select the 'extension/' folder"
  echo "  4. Copy the Extension ID shown under the extension name"
  echo "  5. Run: $0 <that-ID>"
  echo ""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_PY="$SCRIPT_DIR/proxy_host.py"

if [[ ! -f "$PROXY_PY" ]]; then
  echo "ERROR: proxy_host.py not found at $PROXY_PY"
  exit 1
fi

# Make sure Python 3 is available
PYTHON=$(command -v python3 || command -v python || true)
if [[ -z "$PYTHON" ]]; then
  echo "ERROR: Python 3 is required but not found in PATH."
  exit 1
fi

PY_VERSION=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
if [[ "$PY_VERSION" -lt 3 ]]; then
  echo "ERROR: Python 3 is required (found Python $PY_VERSION)."
  exit 1
fi

# Update the shebang in proxy_host.py to use the detected Python
sed -i "1s|.*|#!$PYTHON|" "$PROXY_PY"
chmod +x "$PROXY_PY"

# Determine native messaging host directory
if [[ "$(uname)" == "Darwin" ]]; then
  # macOS
  NM_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
else
  # Linux
  NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
  # Also try Chromium
  CHROMIUM_NM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
fi

mkdir -p "$NM_DIR"

MANIFEST="$NM_DIR/com.chromeproxy.host.json"

cat > "$MANIFEST" <<EOF
{
  "name": "com.chromeproxy.host",
  "description": "Chrome Proxy Native Host — HTTP/HTTPS proxy server",
  "path": "$PROXY_PY",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

echo "  Installed native messaging manifest to:"
echo "  $MANIFEST"

# Also install for Chromium on Linux
if [[ -n "${CHROMIUM_NM_DIR:-}" ]]; then
  mkdir -p "$CHROMIUM_NM_DIR"
  cp "$MANIFEST" "$CHROMIUM_NM_DIR/com.chromeproxy.host.json"
  echo "  Also installed for Chromium: $CHROMIUM_NM_DIR"
fi

echo ""
echo "  Done! Extension ID: $EXTENSION_ID"
echo "  Python:             $PYTHON"
echo "  Proxy script:       $PROXY_PY"
echo ""
echo "  Go to the extension popup and click 'Start Proxy'."
echo "  Then configure other apps to use proxy: 127.0.0.1:8080"
echo ""
