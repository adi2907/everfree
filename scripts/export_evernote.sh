#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# ExitNote — Evernote → Markdown → Git Migration Pipeline
#
# Prerequisites:
#   pip install evernote-backup
#   brew install evernote2md
#   git must be installed and configured with SSH/HTTPS credentials
#
# Usage:
#   chmod +x scripts/export_evernote.sh
#   ./scripts/export_evernote.sh
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
NOTES_DIR="${EXITNOTE_DIR:-$HOME/Documents/ExitNote}"
DB_FILE="en_backup.db"
ENEX_EXPORT_DIR="enex_export"

echo "╔══════════════════════════════════════════════════╗"
echo "║    ExitNote — Evernote → Git Migration Pipeline  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Notes will be saved to: $NOTES_DIR"
echo ""

# ── Step 1: Initialize the backup database ───────────────────
echo "━━━ Step 1/5: Initializing backup database ━━━"
if [ ! -f "$DB_FILE" ]; then
    evernote-backup init-db --database "$DB_FILE"
    echo "✓ Database created: $DB_FILE"
else
    echo "✓ Database already exists: $DB_FILE (skipping init)"
fi

# ── Step 2: Sync notes from Evernote ─────────────────────────
echo ""
echo "━━━ Step 2/5: Syncing notes from Evernote ━━━"
echo "  (You may be prompted to authenticate with Evernote)"
evernote-backup sync --database "$DB_FILE"
echo "✓ Sync complete"

# ── Step 3: Export to .enex files ────────────────────────────
echo ""
echo "━━━ Step 3/5: Exporting to .enex files ━━━"
rm -rf "$ENEX_EXPORT_DIR"
mkdir -p "$ENEX_EXPORT_DIR"
evernote-backup export --database "$DB_FILE" "$ENEX_EXPORT_DIR"
echo "✓ Exported .enex files to: $ENEX_EXPORT_DIR/"

# ── Step 4: Convert .enex → Markdown ────────────────────────
echo ""
echo "━━━ Step 4/5: Converting .enex to Markdown ━━━"
mkdir -p "$NOTES_DIR"

CONVERTED=0
for enex_file in "$ENEX_EXPORT_DIR"/*.enex; do
    [ -f "$enex_file" ] || continue

    notebook_name=$(basename "$enex_file" .enex)
    notebook_dir="$NOTES_DIR/$notebook_name"
    mkdir -p "$notebook_dir"

    echo "  Converting: $notebook_name"
    evernote2md "$enex_file" "$notebook_dir"
    CONVERTED=$((CONVERTED + 1))
done

echo ""
echo "✓ Converted $CONVERTED notebook(s) to Markdown"

# ── Step 5: Initialize Git repo and push to GitHub ───────────
echo ""
echo "━━━ Step 5/5: Setting up Git-backed sync ━━━"

cd "$NOTES_DIR"

# Initialize git if not already a repo
if [ ! -d ".git" ]; then
    git init
    echo "✓ Initialized Git repository"
else
    echo "✓ Git repository already initialized"
fi

# Create .gitignore
cat > .gitignore <<'EOF'
.DS_Store
*.swp
*.swo
*~
EOF
echo "✓ Created .gitignore"

# Initial commit
git add .
git commit -m "Initial import: exported $CONVERTED notebook(s) from Evernote" || {
    echo "  (No changes to commit — files may already be committed)"
}

# Prompt for remote
echo ""
echo "┌─────────────────────────────────────────────────────┐"
echo "│  ⚠  IMPORTANT: Make sure your GitHub repo is       │"
echo "│     set to PRIVATE before proceeding!               │"
echo "│                                                     │"
echo "│  Create a private repo at:                          │"
echo "│  https://github.com/new                             │"
echo "└─────────────────────────────────────────────────────┘"
echo ""

# Check if origin already exists
if git remote get-url origin &>/dev/null; then
    EXISTING_URL=$(git remote get-url origin)
    echo "Remote 'origin' already set to: $EXISTING_URL"
    read -p "Replace with a new URL? [y/N] " replace
    if [[ "$replace" =~ ^[Yy]$ ]]; then
        read -p "Enter your PRIVATE GitHub repo URL: " REPO_URL
        git remote set-url origin "$REPO_URL"
        echo "✓ Updated remote to: $REPO_URL"
    fi
else
    read -p "Enter your PRIVATE GitHub repo URL: " REPO_URL
    git remote add origin "$REPO_URL"
    echo "✓ Added remote: $REPO_URL"
fi

# Push
echo ""
echo "Pushing to GitHub…"
git branch -M main
git push -u origin main
echo "✓ Pushed to GitHub"

# ── Cleanup ──────────────────────────────────────────────────
echo ""
cd - > /dev/null
read -p "Remove temporary .enex files and database? [y/N] " cleanup
if [[ "$cleanup" =~ ^[Yy]$ ]]; then
    rm -rf "$ENEX_EXPORT_DIR" "$DB_FILE"
    echo "✓ Cleaned up temporary files"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Migration complete!                             ║"
echo "║                                                  ║"
echo "║  Notes: $NOTES_DIR"
echo "║  Git:   Synced to GitHub (private repo)          ║"
echo "║                                                  ║"
echo "║  Run 'python run.py' to start ExitNote.          ║"
echo "╚══════════════════════════════════════════════════╝"
