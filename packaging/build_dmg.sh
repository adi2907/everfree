#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# EverFree — Build macOS .app and .dmg
#
# Prerequisites:
#   brew install create-dmg
#   pip install py2app   (or use the venv created below)
#
# Usage:
#   chmod +x packaging/build_dmg.sh
#   ./packaging/build_dmg.sh
#   ./packaging/build_dmg.sh --sign-only
#   ./packaging/build_dmg.sh --release
#
# One-time release setup:
#   xcrun notarytool store-credentials "EverFree-notary" \
#       --apple-id "YOUR_APPLE_ID" \
#       --team-id "YOUR_TEAM_ID"
# ──────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="EverFree"
DMG_NAME="${APP_NAME}.dmg"
APP_ICON="$PROJECT_DIR/packaging/EverFree.icns"
APP_PATH="$DIST_DIR/${APP_NAME}.app"
DMG_PATH="$DIST_DIR/$DMG_NAME"
RELEASE_BUILD=0
SIGN_ONLY_BUILD=0
SIGN_IDENTITY="${EVERFREE_SIGN_IDENTITY:-Developer ID Application: Aditya Ganguli (928FCT369C)}"
NOTARY_PROFILE="${EVERFREE_NOTARY_PROFILE:-EverFree-notary}"

usage() {
    cat <<USAGE
Usage: $0 [--sign-only] [--release]

Options:
  --sign-only  Sign the app and DMG, but skip Apple notarization.
  --release    Sign the app and DMG, submit to Apple notarization, and staple.

Environment:
  EVERFREE_SIGN_IDENTITY    Developer ID Application identity.
                            Default: $SIGN_IDENTITY
  EVERFREE_NOTARY_PROFILE   notarytool keychain profile.
                            Default: $NOTARY_PROFILE
USAGE
}

sign_macho_files() {
    local signed_count=0
    while IFS= read -r -d '' file_path; do
        if file "$file_path" | grep -q "Mach-O"; then
            codesign --remove-signature "$file_path" 2>/dev/null || true
            codesign --force --options runtime --timestamp \
                --sign "$SIGN_IDENTITY" \
                "$file_path"
            signed_count=$((signed_count + 1))
        fi
    done < <(find "$APP_PATH" -type f -print0)
    echo "✓ Signed $signed_count embedded Mach-O file(s)"
}

remove_bundle_signatures() {
    find "$APP_PATH" -name _CodeSignature -type d -prune -exec rm -rf {} +
}

sign_nested_bundles() {
    if [[ -d "$APP_PATH/Contents/Frameworks/Python.framework" ]]; then
        codesign --force --options runtime --timestamp \
            --sign "$SIGN_IDENTITY" \
            "$APP_PATH/Contents/Frameworks/Python.framework"
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --release)
            RELEASE_BUILD=1
            shift
            ;;
        --sign-only)
            SIGN_ONLY_BUILD=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

echo "╔══════════════════════════════════════════════════╗"
echo "║      EverFree — macOS Build Pipeline              ║"
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
echo "✓ Built: $APP_PATH"

if [[ "$RELEASE_BUILD" -eq 1 ]]; then
    SIGN_ONLY_BUILD=1
fi

if [[ "$SIGN_ONLY_BUILD" -eq 1 ]]; then
    echo ""
    echo "━━━ Signing ${APP_NAME}.app ━━━"
    if ! security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
        echo "Signing identity not found or not valid: $SIGN_IDENTITY" >&2
        exit 1
    fi

    remove_bundle_signatures
    sign_macho_files
    sign_nested_bundles

    codesign --force --options runtime --timestamp \
        --sign "$SIGN_IDENTITY" \
        "$APP_PATH"

    codesign --verify --deep --strict --verbose=2 "$APP_PATH"
    spctl --assess --type execute --verbose "$APP_PATH" || true
    echo "✓ Signed: $APP_PATH"
fi

# ── Step 4: Package into .dmg ───────────────────────────────
echo ""
echo "━━━ Step 4/4: Creating DMG installer ━━━"

# Remove old DMG if it exists
rm -f "$DMG_PATH"

create-dmg \
    --volname "$APP_NAME" \
    --volicon "$APP_ICON" \
    --window-pos 200 120 \
    --window-size 600 400 \
    --icon-size 100 \
    --icon "${APP_NAME}.app" 150 190 \
    --app-drop-link 450 190 \
    --hide-extension "${APP_NAME}.app" \
    "$DMG_PATH" \
    "$APP_PATH" \
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
            "$DMG_PATH" \
            "$APP_PATH"
    }

echo ""
echo "✓ DMG created: $DMG_PATH"

if [[ "$SIGN_ONLY_BUILD" -eq 1 ]]; then
    echo ""
    echo "━━━ Signing ${DMG_NAME} ━━━"
    codesign --force --timestamp \
        --sign "$SIGN_IDENTITY" \
        "$DMG_PATH"
    codesign --verify --verbose=2 "$DMG_PATH"
    echo "✓ Signed: $DMG_PATH"
fi

if [[ "$RELEASE_BUILD" -eq 1 ]]; then
    echo ""
    echo "━━━ Notarizing ${DMG_NAME} ━━━"
    NOTARY_OUTPUT="$DIST_DIR/notary-submit.json"
    xcrun notarytool submit "$DMG_PATH" \
        --keychain-profile "$NOTARY_PROFILE" \
        --wait \
        --output-format json | tee "$NOTARY_OUTPUT"

    if ! grep -q '"status"[[:space:]]*:[[:space:]]*"Accepted"' "$NOTARY_OUTPUT"; then
        echo "Notarization was not accepted. See $NOTARY_OUTPUT and run:" >&2
        echo "  xcrun notarytool log <submission-id> --keychain-profile \"$NOTARY_PROFILE\"" >&2
        exit 1
    fi

    echo ""
    echo "━━━ Stapling notarization ticket ━━━"
    xcrun stapler staple "$DMG_PATH"
    xcrun stapler validate "$DMG_PATH"
    spctl --assess --type open --context context:primary-signature --verbose "$DMG_PATH"
    echo "✓ Notarized and stapled: $DMG_PATH"
fi
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Build complete!                                  ║"
echo "║  $DMG_PATH"
echo "╚══════════════════════════════════════════════════╝"

# Deactivate venv
deactivate
