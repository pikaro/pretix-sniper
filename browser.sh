#!/usr/bin/env bash

set -eEuo pipefail

. .env

if [ "${INSTANCE_COUNT}" -gt 10 ]; then
    echo "INSTANCE_COUNT must be <= 10"
    exit 1
fi

TMP_ROOT="/tmp/pretix-sniper"
mkdir -p "$TMP_ROOT"

_cleanup() {
    rm -rf "$TMP_ROOT"
    echo "Cleaned up temporary Chrome profiles."
}

trap _cleanup EXIT

for ((i = 0; i < INSTANCE_COUNT; i++)); do
    TMP="$(mktemp -d "$TMP_ROOT/chrome-profile.XXXXXX")"

    open -na "Google Chrome" --args \
        --remote-debugging-port="$((PORT_BASE + i - 1))" \
        --user-data-dir="$TMP" \
        --no-first-run \
        --no-default-browser-check \
        --disable-search-engine-choice-screen \
        --new-window \
        "$URL"
done

read -rp "Press enter after closing all browser windows"
