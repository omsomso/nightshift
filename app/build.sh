#!/bin/sh
# Builds Nightshift.app into app/build/. Uses Xcode's toolchain when Xcode is installed,
# because the Command Line Tools' swift-package can be out of sync with its libraries.
set -eu
cd "$(dirname "$0")"
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcrun swift build -c release
bin="$(xcrun swift build -c release --show-bin-path)/Nightshift"
app=build/Nightshift.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Nightshift"
cp Resources/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Nightshift</string>
  <key>CFBundleDisplayName</key><string>Nightshift</string>
  <key>CFBundleIdentifier</key><string>local.nightshift.app</string>
  <key>CFBundleExecutable</key><string>Nightshift</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.5.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# Ad-hoc signature: enough for a local app; not for distribution.
codesign --force --sign - "$app"
echo "Built $(pwd)/$app"
