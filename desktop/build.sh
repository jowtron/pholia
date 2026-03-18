#!/bin/sh
# Build Cadence desktop app from the latest web files
cd "$(dirname "$0")"

# Copy web files into frontend/ for embedding
rm -rf frontend
mkdir frontend
cp ../index.html ../style.css ../api.js ../app.js ../player.js ../manifest.json ../favicon.ico frontend/
cp -r ../icons frontend/

# Generate proper multi-resolution .icns from source PNG
ICONSET=$(mktemp -d)/cadence.iconset
mkdir -p "$ICONSET"
sips -z 16 16     ../cadence.png --out "$ICONSET/icon_16x16.png"      > /dev/null 2>&1
sips -z 32 32     ../cadence.png --out "$ICONSET/icon_16x16@2x.png"   > /dev/null 2>&1
sips -z 32 32     ../cadence.png --out "$ICONSET/icon_32x32.png"      > /dev/null 2>&1
sips -z 64 64     ../cadence.png --out "$ICONSET/icon_32x32@2x.png"   > /dev/null 2>&1
sips -z 128 128   ../cadence.png --out "$ICONSET/icon_128x128.png"    > /dev/null 2>&1
sips -z 256 256   ../cadence.png --out "$ICONSET/icon_128x128@2x.png" > /dev/null 2>&1
sips -z 256 256   ../cadence.png --out "$ICONSET/icon_256x256.png"    > /dev/null 2>&1
sips -z 512 512   ../cadence.png --out "$ICONSET/icon_256x256@2x.png" > /dev/null 2>&1
sips -z 512 512   ../cadence.png --out "$ICONSET/icon_512x512.png"    > /dev/null 2>&1
sips -z 1024 1024 ../cadence.png --out "$ICONSET/icon_512x512@2x.png" > /dev/null 2>&1
iconutil -c icns "$ICONSET" -o build/appicon.icns
rm -rf "$(dirname "$ICONSET")"

# If called with --full, also run wails build
if [ "$1" = "--full" ]; then
    wails build
    # Replace Wails-generated .icns with our proper one
    cp build/appicon.icns build/bin/Cadence.app/Contents/Resources/iconfile.icns
    echo "Built: build/bin/Cadence.app"
fi
