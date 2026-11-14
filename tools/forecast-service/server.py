"""Local demand-forecast service for FlowChain's reorder list: TimesFM 2.5 (google/timesfm-2.5-200m-pytorch) on CPU.

    <python with torch and timesfm> tools/forecast-service/server.py [--port 18850] [--self-test]

FlowChain's API calls it only when FLOWCHAIN_FORECAST_URL is set (for example http://127.0.0.1:18850). It listens on
127.0.0.1 only and keeps no data: each request carries the series it needs.

POST /v1/quantiles   {"series": [[number, ...], ...], "quantile": 0.8333}
  Each series is one item's history as equal-length period totals (for example 21-day shipment totals), oldest
  first. The reply gives, per series, the requested quantile of the next period's total:
  -> {"model": "google/timesfm-2.5-200m-pytorch", "quantile": 0.8333, "values": [number | null, ...]}
  A series of zeros gets 0 without calling the model; a series shorter than 2 periods gets null.
GET /health          -> {"status": "ok", "model": "..."}

Why one period ahead: the reorder level is a quantile of the total demand over the days one order must cover. Adding
up daily quantiles would overstate it, so the history is summed into periods of that length and the model forecasts
one period. TimesFM's quantile head gives deciles 0.1 .. 0.9; other levels inside that range are interpolated.
Backtest on public data (M5, UCI Online Retail II): .local/research/forecast-backtest in the owner's checkout.
"""

from __future__ import annotations

import argparse
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_ID = "google/timesfm-2.5-200m-pytorch"
MAX_SERIES = 5000
MAX_LENGTH = 4096
MAX_BODY = 8 * 1024 * 1024
DECILES = np.arange(1, 10) / 10


class Forecaster:
    def __init__(self, threads: int = 8, batch: int = 128, context: int = 256):
        import torch
        import timesfm

        torch.set_num_threads(threads)
        self.model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL_ID)
        self.model.compile(timesfm.ForecastConfig(
            max_context=context, max_horizon=16, normalize_inputs=True, use_continuous_quantile_head=True,
            force_flip_invariance=True, infer_is_positive=True, fix_quantile_crossing=True,
            per_core_batch_size=batch))
        self.context = context
        self.lock = threading.Lock()          # one inference at a time

    def quantiles(self, series: list[list[float]], q: float) -> list[float | None]:
        values: list[float | None] = [None] * len(series)
        todo = []
        for i, row in enumerate(series):
            if len(row) < 2:
                continue
            if not any(row):
                values[i] = 0.0
                continue
            todo.append(i)
        if todo:
            inputs = [np.asarray(series[i][-self.context:], dtype=float) for i in todo]
            with self.lock:
                _point, qf = self.model.forecast(horizon=1, inputs=inputs)
            qf = np.asarray(qf)[:, 0, 1:]       # drop the mean column: deciles 0.1 .. 0.9
            for i, row in zip(todo, qf):
                values[i] = max(0.0, float(np.interp(q, DECILES, row)))
        return values


def validate(payload) -> tuple[list[list[float]], float]:
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    q = payload.get("quantile")
    if not isinstance(q, (int, float)) or not (0.1 <= q <= 0.9):
        raise ValueError("quantile must be a number from 0.1 to 0.9")
    series = payload.get("series")
    if not isinstance(series, list) or len(series) > MAX_SERIES:
        raise ValueError(f"series must be a list of at most {MAX_SERIES} series")
    out = []
    for row in series:
        if not isinstance(row, list) or len(row) > MAX_LENGTH:
            raise ValueError(f"each series must be a list of at most {MAX_LENGTH} numbers")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 for v in row):
            raise ValueError("series values must be finite numbers >= 0")
        out.append([float(v) for v in row])
    return out, float(q)


def make_handler(forecaster: Forecaster):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                self._send(200, {"status": "ok", "model": MODEL_ID})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/v1/quantiles":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._send(413 if length > MAX_BODY else 400, {"error": "missing or oversized body"})
                return
            try:
                series, q = validate(json.loads(self.rfile.read(length)))
            except (ValueError, json.JSONDecodeError) as error:
                self._send(400, {"error": str(error)})
                return
            start = time.time()
            try:
                values = forecaster.quantiles(series, q)
            except Exception as error:  # noqa: BLE001 - report, keep serving
                self._send(500, {"error": f"forecast failed: {type(error).__name__}"})
                return
            self._send(200, {"model": MODEL_ID, "quantile": q, "values": values,
                             "seconds": round(time.time() - start, 3)})

        def log_message(self, fmt, *args):  # one short line per request
            print(f"{self.log_date_time_string()} {fmt % args}", flush=True)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=18850)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--self-test", action="store_true", help="forecast two small series, print them and exit")
    args = parser.parse_args()
    print(f"loading {MODEL_ID} ...", flush=True)
    forecaster = Forecaster(threads=args.threads)
    if args.self_test:
        steady = [100.0, 104, 98, 101, 99, 103, 100, 97, 102, 100]
        season = [10.0, 12, 15, 30, 60, 90, 40, 15, 10, 12, 15, 32, 65]
        print(json.dumps({"steady": forecaster.quantiles([steady], 5 / 6), "seasonal": forecaster.quantiles([season], 5 / 6),
                          "zeros": forecaster.quantiles([[0.0, 0.0, 0.0]], 5 / 6)}))
        return
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(forecaster))
    print(f"forecast service ready on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
