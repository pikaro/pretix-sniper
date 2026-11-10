#!/usr/bin/env python3
import argparse
import math
import statistics
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

import requests

SAMPLES = 10
EXPECTED_HEADERS_MS = 110.0
HEADERS_TOLERANCE_MS = 25.0
IDLE_SECONDS = 10.0


@dataclass(frozen=True)
class TimedResponse:
    request_epoch_ms: float
    server_render_epoch_ms: float
    headers_ms: float
    body_ms: float


class ServerTimestampParser(HTMLParser):
    value: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "body":
            self.value = dict(attrs).get("data-now")


def get_response(session: requests.Session, url: str) -> TimedResponse:
    request_epoch_ms = time.time_ns() / 1e6
    with session.get(url, timeout=5, stream=True, allow_redirects=False) as response:
        headers_received_ns = time.perf_counter_ns()
        response.raise_for_status()
        if not 200 <= response.status_code < 300:
            raise RuntimeError(
                f"HTTP {response.status_code}: use a URL that returns a fresh queue response"
            )
        # A streamed response must be consumed before its connection can be reused.
        html = response.text
        body_ms = (time.perf_counter_ns() - headers_received_ns) / 1e6
        parser = ServerTimestampParser()
        parser.feed(html)
        try:
            server_render_epoch_ms = float(parser.value or "") * 1000
        except ValueError as error:
            raise RuntimeError("Missing or invalid body[data-now] timestamp") from error
        if not math.isfinite(server_render_epoch_ms) or server_render_epoch_ms <= 0:
            raise RuntimeError("Invalid body[data-now] timestamp")
        return TimedResponse(
            request_epoch_ms=request_epoch_ms,
            server_render_epoch_ms=server_render_epoch_ms,
            headers_ms=response.elapsed.total_seconds() * 1000,
            body_ms=body_ms,
        )


def check_timing(session: requests.Session, url: str) -> list[TimedResponse]:
    get_response(session, url)
    samples = []
    timings = []
    for _ in range(SAMPLES):
        time.sleep(IDLE_SECONDS)
        response = get_response(session, url)
        samples.append(response)
        timings.append(response.headers_ms)
        print(
            f"After {IDLE_SECONDS:g}s idle: headers {response.headers_ms:.2f} ms | "
            f"body {response.body_ms:.2f} ms | "
            f"server render {response.server_render_epoch_ms:.3f} ms epoch | "
            f"offset {response.request_epoch_ms - response.server_render_epoch_ms:+.3f} ms",
            flush=True,
        )
    median_ms = statistics.median(timings)
    print(
        f"Header latency median {median_ms:.2f} ms "
        f"(range {min(timings):.2f}–{max(timings):.2f} ms); "
        f"expected {EXPECTED_HEADERS_MS:g} ± {HEADERS_TOLERANCE_MS:g} ms",
        flush=True,
    )
    if abs(median_ms - EXPECTED_HEADERS_MS) > HEADERS_TOLERANCE_MS:
        raise RuntimeError(
            "Python header latency does not match the browser measurement"
        )
    return samples


def calibrate(samples: list[TimedResponse]) -> float:
    offsets = [
        sample.request_epoch_ms - sample.server_render_epoch_ms for sample in samples
    ]
    offset = statistics.median(offsets)
    print(
        f"\nServer-render offset: {offset:+.3f} ms "
        f"(range {min(offsets):+.3f}–{max(offsets):+.3f} ms; "
        "negative = earlier, positive = later)",
        flush=True,
    )
    return offset


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Calibrate against body[data-now] with a persistent HTTP session.",
        epilog=(
            "Reload time = target + calibrated offset + manual correction. "
            "Negative values mean earlier; positive values mean later."
        ),
    )
    parser.add_argument("url")
    parser.add_argument("target", nargs="?", help="ISO timestamp including timezone")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Measure timings and calibrate without a keypress",
    )
    parser.add_argument(
        "--correction-ms",
        type=float,
        help="Shift only the final keypress: positive later, negative earlier (default: 0 ms)",
    )
    args = parser.parse_args()
    if args.check and args.target is not None:
        parser.error("--check does not accept a target timestamp")
    if not args.check and args.target is None:
        parser.error("a target timestamp is required unless --check is used")
    if args.check and args.correction_ms is not None:
        parser.error("--correction-ms requires a target timestamp")
    correction_ms = args.correction_ms if args.correction_ms is not None else 0.0
    if not math.isfinite(correction_ms):
        parser.error("--correction-ms must be a finite number of milliseconds")
    target = None
    if args.target is not None:
        try:
            target = datetime.fromisoformat(args.target)
        except ValueError:
            parser.error("target must be an ISO timestamp")
        if target.utcoffset() is None:
            parser.error("target must include a timezone")
        if target.timestamp() <= time.time():
            parser.error("target has already passed")

    with requests.Session() as session:
        session.headers["Cache-Control"] = "no-cache"
        session.cookies.set(
            "intro_seen_40c3", "true", domain="tickets.events.ccc.de", path="/"
        )
        offset = calibrate(check_timing(session, args.url))
        if args.check:
            return

    assert target is not None
    target_ms = round(target.timestamp() * 1000)
    effective_offset = offset + correction_ms

    if target_ms + effective_offset <= time.time_ns() / 1e6:
        raise RuntimeError("Target has passed during calibration")
    print(
        f"Manual correction: {correction_ms:+.3f} ms; "
        f"effective offset: {effective_offset:+.3f} ms",
        flush=True,
    )

    # The C executable takes a lead time, so negate our signed offset at this boundary
    subprocess.run(
        [
            str(Path(__file__).with_name("keypress")),
            str(target_ms),
            f"{-effective_offset:.3f}",
        ],
        check=True,
    )


if __name__ == "__main__":
    try:
        main()
    except (requests.RequestException, RuntimeError, ValueError) as error:
        raise SystemExit(str(error)) from error
