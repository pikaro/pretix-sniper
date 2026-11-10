#!/bin/bash

_in_3_min() {
    now="$(date -u +%s)"
    now_min="$((now - now % 60))"
    date -d "@$((now_min + 180))" -u +%Y-%m-%dT%H:%M:%SZ | tee >(cat - >&2)
}

node snipe.mjs \
    "https://tickets.events.ccc.de/40c3/" \
    --correction-ms 50 \
    "$(_in_3_min)"
# "2026-11-11T17:00:00Z"
