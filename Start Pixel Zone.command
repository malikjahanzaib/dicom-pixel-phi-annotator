#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null; then
  echo 'Node.js is required. Install Node.js, then reopen this launcher.'
  read -r '?Press Return to close.'
  exit 1
fi
if [ ! -d node_modules ]; then
  echo 'Install dependencies once with npm ci, then reopen this launcher.'
  read -r '?Press Return to close.'
  exit 1
fi
npm run build || exit 1
npm start -- --open
