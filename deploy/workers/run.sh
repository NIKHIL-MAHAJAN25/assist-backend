#!/bin/bash
# Load the assist user's nvm Node (not loaded for non-interactive shells), then start the pool.
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
exec node "$(dirname "$0")/pool.js"
