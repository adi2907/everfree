#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# ExitNote — Build macOS .app and .dmg
#
# Prerequisites:
#   brew install create-dmg
#   pip install py2app   (or use the venv created below)
#
# Usage:
#   chmod +x packaging/build_dmg.sh
#   ./packaging/build_dmg.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="ExitNote"
DMG_NAME="${APP_NAME}.dmg"

echo "╔══════════════════════════════════════════════════╗"
echo "║      ExitNote — macOS Build Pipeline              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create / activate venv ──────────────────────────
echo "━━━ Step 1/4: Setting up Python virtual environment ━━━"
VENV_DIR="$PROJECT_DIR/.build-venv"
# Always start fresh to avoid stale package issues
rm -rf "$VENV_DIR"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
# py2app depends on pkg_resources which was removed in setuptools>=78
# Install explicit jaraco dependencies so py2app can bundle them natively
pip install --quiet "setuptools>=70,<78" "jaraco.text" "jaraco.functools" "jaraco.context" "more_itertools"
pip install --quiet -r "$PROJECT_DIR/requirements.txt"
echo "✓ Virtual environment ready"

# ── Step 2: Clean previous builds ───────────────────────────
echo ""
echo "━━━ Step 2/4: Cleaning previous builds ━━━"
rm -rf "$BUILD_DIR" "$DIST_DIR"
echo "✓ Cleaned build/ and dist/"

# ── Step 3: Build .app with py2app ──────────────────────────
echo ""
echo "━━━ Step 3/4: Building ${APP_NAME}.app ━━━"
cd "$PROJECT_DIR"
python packaging/setup_py2app.py py2app --dist-dir "$DIST_DIR"
echo "✓ Built: $DIST_DIR/${APP_NAME}.app"

# ── Step 4: Package into .dmg ───────────────────────────────
echo ""
echo "━━━ Step 4/4: Creating DMG installer ━━━"

# Remove old DMG if it exists
rm -f "$DIST_DIR/$DMG_NAME"

create-dmg \
    --volname "$APP_NAME" \
    --volicon "$DIST_DIR/${APP_NAME}.app/Contents/Resources/PythonApplet.icns" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "${APP_NAME}.app" 150 190 \
    --app-drop-link 450 190 \
    --hide-extension "${APP_NAME}.app" \
    "$DIST_DIR/$DMG_NAME" \
    "$DIST_DIR/${APP_NAME}.app" \
    || {
        # create-dmg returns non-zero if the volume icon is missing; fall back
        echo "⚠ create-dmg with icon failed, retrying without --volicon…"
        create-dmg \
            --volname "$APP_NAME" \
            --window-pos 200 120 \
            --window-size 600 400 \
            --icon-size 100 \
            --icon "${APP_NAME}.app" 150 190 \
            --app-drop-link 450 190 \
            --hide-extension "${APP_NAME}.app" \
            "$DIST_DIR/$DMG_NAME" \
            "$DIST_DIR/${APP_NAME}.app"
    }

echo ""
echo "✓ DMG created: $DIST_DIR/$DMG_NAME"
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Build complete!                                  ║"
echo "║  $DIST_DIR/$DMG_NAME"
echo "╚══════════════════════════════════════════════════╝"

# Deactivate venv
deactivate
