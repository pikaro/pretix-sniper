#!/bin/bash

set -eEuo pipefail

. .env

TMP_ROOT="/tmp/pretix-sniper-logs"
mkdir -p "$TMP_ROOT"

_cleanup() {
    rm -rf "$TMP_ROOT"
    echo "Cleaned up temporary logs."
}

trap _cleanup EXIT

_in_3_min() {
    now="$(date -u +%s)"
    now_min="$((now - now % 60))"
    date -d "@$((now_min + 180))" -u +%Y-%m-%dT%H:%M:%SZ | tee >(cat - >&2)
}

if [ "${LIVE}" -eq 1 ]; then
    T0="${SALE}"
else
    T0="$(_in_3_min)"
fi

_run() {
    local i="${1}"
    local PORT=$((PORT_BASE + i - 1))
    local MS="$((CORRECTION_MS_MIN + (i * CORRECTION_MS_STAGGER)))"
    env -u NO_COLOR FORCE_COLOR=1 node snipe.mjs \
        "${URL}" \
        --correction-ms "${MS}" \
        --port "${PORT}" \
        "${T0}"
}

PIDS=()

for ((i = 1; i <= INSTANCE_COUNT; i++)); do
    _run "$((i - 1))" >"$TMP_ROOT/instance-${i}.log" 2>&1 &
    PIDS+=("$!")
    if ((i < INSTANCE_COUNT)); then
        sleep 1
    fi
done

TAIL_PID=

_tail() {
    local i="$1"

    if [[ -n "$TAIL_PID" ]]; then
        kill "$TAIL_PID" 2>/dev/null || true
        wait "$TAIL_PID" 2>/dev/null || true
    fi

    clear
    echo "Showing instance $((i)) of $INSTANCE_COUNT"
    echo "Enter an instance number to switch, or q to quit."

    tail -n +1 -f "$TMP_ROOT/instance-${i}.log" &
    TAIL_PID=$!
}

_tail 1

while IFS= read -rsn1 input </dev/tty; do
    if [[ "$input" == "q" ]]; then
        break
    fi

    if [[ "$input" =~ ^[0-9]$ ]]; then
        instance_num="$((input))"
        if ((instance_num == 0 && INSTANCE_COUNT == 10)); then
            instance_num=10
        fi
        if ((instance_num >= 1 && instance_num <= INSTANCE_COUNT)); then
            _tail "$instance_num"
        else
            echo "Invalid instance number: $instance_num"
        fi
    else
        echo "Invalid input: $input"
    fi
done

kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true
