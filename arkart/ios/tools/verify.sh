#!/usr/bin/env bash
# ARKartPilot self-check. Run from anywhere:  bash arkart/ios/tools/verify.sh
#
# Stages, strongest last:
#   1. xcodegen generate            — the project definition is valid
#   2. swiftc -parse (all sources)  — every file, including the SwiftUI/UIKit views
#   3. swiftc -typecheck (macOS SDK)— full type checking of the Core + Input layers
#   4. headless run vs. a stub STDB — the 25 Hz / 5 Hz loops, both HTTP adapters
#                                     and the SATS decoding, executed for real
#   5. xcodebuild iOS simulator     — needs full Xcode; skipped (loudly) without it
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
SKIPPED_XCODEBUILD=0

banner() { printf '\n=== %s ===\n' "$1"; }

banner "1/5 xcodegen generate"
if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate || FAIL=1
else
  echo "xcodegen not installed (brew install xcodegen)"; FAIL=1
fi

SOURCES=$(find Sources -name '*.swift' | sort)

banner "2/5 swiftc -parse (all $(echo "$SOURCES" | wc -l | tr -d ' ') sources)"
# shellcheck disable=SC2086
if swiftc -parse -swift-version 5 $SOURCES; then
  echo "parse OK"
else
  FAIL=1
fi

SDK=$(xcrun --show-sdk-path --sdk macosx 2>/dev/null)
TARGET="$(uname -m)-apple-macos13.0"

banner "3/5 swiftc -typecheck Core+Input against the macOS SDK"
if [ -n "$SDK" ]; then
  if swiftc -typecheck -swift-version 5 -target "$TARGET" -sdk "$SDK" \
      Sources/Core/*.swift Sources/Input/*.swift; then
    echo "typecheck OK"
  else
    FAIL=1
  fi
else
  echo "no macOS SDK"; FAIL=1
fi

banner "3b/5 swiftc -typecheck the UIKit-free SwiftUI views (macOS SDK)"
# Theme/ControlPads/HUDOverlay/InkOverlay use only cross-platform SwiftUI, so
# they get full type checking here. RootView, SettingsSheet and FPVWebView need
# the iOS SDK (UIViewRepresentable / WKWebView / keyboardType) and are covered
# by stage 2 and by stage 5's xcodebuild.
if swiftc -typecheck -swift-version 5 -target "$TARGET" -sdk "$SDK" \
    Sources/Core/*.swift Sources/Views/Theme.swift Sources/Views/ControlPads.swift \
    Sources/Views/HUDOverlay.swift Sources/Views/InkOverlay.swift; then
  echo "view typecheck OK"
else
  FAIL=1
fi

banner "3c/5 swiftc -typecheck RootView + SettingsSheet with iOS shims"
# Everything except FPVWebView's WKWebView body, type-checked for real: the four
# iOS-only view modifiers and the webview itself are stubbed, so argument order,
# names and view composition are all verified without the iOS SDK.
SHIM="$(mktemp -d)/c"
mkdir -p "$SHIM"
cp Sources/Core/*.swift Sources/Input/*.swift "$SHIM/"
cp Sources/Views/Theme.swift Sources/Views/ControlPads.swift \
   Sources/Views/HUDOverlay.swift Sources/Views/InkOverlay.swift \
   Sources/Views/RootView.swift Sources/Views/SettingsSheet.swift "$SHIM/"
cat > "$SHIM/zshim.swift" <<'SHIMEOF'
import SwiftUI
struct ShimKeyboardType { static let URL = ShimKeyboardType() }
struct ShimAutocap { static let never = ShimAutocap() }
struct ShimTitleMode { static let inline = ShimTitleMode() }
extension View {
    func statusBarHidden(_ hidden: Bool) -> some View { self }
    func keyboardType(_ type: ShimKeyboardType) -> some View { self }
    func textInputAutocapitalization(_ mode: ShimAutocap?) -> some View { self }
    func navigationBarTitleDisplayMode(_ mode: ShimTitleMode) -> some View { self }
}
struct FPVWebView: View {
    let url: URL
    let reloadToken: Int
    var body: some View { Color.black }
}
SHIMEOF
if swiftc -typecheck -swift-version 5 -target "$TARGET" -sdk "$SDK" "$SHIM"/*.swift; then
  echo "composition typecheck OK"
else
  FAIL=1
fi

banner "4/5 headless run against a stub SpacetimeDB"
PORT="${ARKART_STUB_PORT:-38731}"
LOG="$(mktemp -t arkart-stub)"
python3 tools/selfcheck/stub_server.py "$PORT" "$LOG" >/dev/null 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null' EXIT

# Wait for the stub without calling sleep: curl's own retry loop does the waiting.
curl -s -o /dev/null --retry 20 --retry-all-errors --retry-delay 0 -m 2 \
     -X POST "http://127.0.0.1:${PORT}/ready" --data 'ping' 2>/dev/null

# If a real SpacetimeDB with the arkart module is up, test against it too.
LIVE_URL="${ARKART_LIVE_URL:-}"
if [ -z "$LIVE_URL" ]; then
  if curl -s -o /dev/null -m 2 -X POST "http://127.0.0.1:3000/v1/database/arkart/sql" \
       --data 'SELECT * FROM config' 2>/dev/null; then
    LIVE_URL="http://127.0.0.1:3000"
    echo "live arkart module detected at $LIVE_URL — including live assertions"
  else
    echo "no live arkart module on :3000 — stub assertions only"
  fi
fi

BINDIR="$(mktemp -d)"
if swiftc -swift-version 5 -target "$TARGET" -sdk "$SDK" \
    Sources/Core/*.swift tools/selfcheck/main.swift -o "$BINDIR/arkart-selfcheck"; then
  ARKART_STUB_PORT="$PORT" ARKART_STUB_LOG="$LOG" ARKART_LIVE_URL="$LIVE_URL" \
    "$BINDIR/arkart-selfcheck" || FAIL=1
else
  echo "self-check harness failed to build"; FAIL=1
fi
kill "$STUB_PID" 2>/dev/null

banner "5/5 xcodebuild — iOS simulator"
if xcodebuild -version >/dev/null 2>&1; then
  xcodebuild -project ARKartPilot.xcodeproj -scheme ARKartPilot \
    -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
    build || FAIL=1
else
  SKIPPED_XCODEBUILD=1
  echo "SKIPPED — full Xcode is not installed on this machine."
  echo "  xcode-select -p = $(xcode-select -p 2>/dev/null)"
  echo "  Install Xcode from the App Store, then:"
  echo "    sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  echo "    sudo xcodebuild -runFirstLaunch"
  echo "  and re-run this script."
fi

banner "result"
if [ "$FAIL" -eq 0 ] && [ "$SKIPPED_XCODEBUILD" -eq 0 ]; then
  echo "ALL STAGES PASSED"
elif [ "$FAIL" -eq 0 ]; then
  echo "PASSED stages 1-4; stage 5 (xcodebuild) SKIPPED — no Xcode on this machine"
  exit 3
else
  echo "FAILURES — see above"
  exit 1
fi
