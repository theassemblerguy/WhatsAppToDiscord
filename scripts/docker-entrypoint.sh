#!/bin/sh
set -eu

APP_DIR="/usr/local/WA2DC"
STORAGE_DIR="${WA2DC_STORAGE_DIR:-$APP_DIR/storage}"

if [ "$#" -eq 0 ]; then
	set -- node src/index.js
fi

if [ "$(id -u)" -eq 0 ]; then
	mkdir -p "$STORAGE_DIR"
	chown -R node:node "$STORAGE_DIR" || true
	exec gosu node "$@"
fi

exec "$@"
