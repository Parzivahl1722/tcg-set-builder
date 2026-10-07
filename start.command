#!/bin/zsh -il
# Double-click launcher for macOS. Starts TCG Set Builder and opens it in your browser.
# Closing this Terminal window (or pressing Ctrl+C) stops the app.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org, then run this again."
  read -k 1 "?Press any key to close."
  exit 1
fi

[ -d node_modules ] || npm install

PORT="${PORT:-3000}"

# Something is already listening: open it instead of crashing with EADDRINUSE.
# It may be an older copy of this app (check with: lsof -i :$PORT) or another program.
if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is already in use, so TCG Set Builder is probably already running."
  echo "Opening http://localhost:$PORT. To start a fresh copy, stop the other one first (lsof -i :$PORT)."
  open "http://localhost:$PORT"
  read -k 1 "?Press any key to close."
  exit 0
fi

# Keep the collection outside the repo so re-cloning or deleting the project folder can't lose it.
# Override with DATA_DIR (for example a synced iCloud or Dropbox folder).
export DATA_DIR="${DATA_DIR:-$HOME/TCG Set Builder Data}"
mkdir -p "$DATA_DIR" || exit 1

# One-time migration: copy (never move) an existing in-repo collection into the new folder.
if [ ! -f "$DATA_DIR/collection.json" ] && [ -f data/collection.json ]; then
  cp data/collection.json "$DATA_DIR/collection.json"
  [ -d data/backups ] && cp -R data/backups "$DATA_DIR/backups"
  echo "Copied your existing collection from $PWD/data to $DATA_DIR (the original is untouched)."
fi
echo "Collection folder: $DATA_DIR"

(sleep 2; open "http://localhost:$PORT") &
PORT="$PORT" npm start
