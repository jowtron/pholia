#!/bin/sh
# Copy web files into frontend/ for embedding, then build Wails app
cd "$(dirname "$0")"
rm -rf frontend
mkdir frontend
cp ../index.html ../style.css ../api.js ../app.js ../player.js ../manifest.json ../favicon.ico frontend/
cp -r ../icons frontend/

# If called with --full, also run wails build
if [ "$1" = "--full" ]; then
    wails build
    echo "Built: build/bin/Cadence.app"
fi
