# Forecast service (TimesFM 2.5, local)

A small local HTTP service that gives FlowChain's reorder list a second suggested reorder point from TimesFM 2.5,
Google's open time-series model (`google/timesfm-2.5-200m-pytorch`, Apache-2.0). It runs on the CPU of the machine
FlowChain runs on; no data leaves it. FlowChain works the same without it: the reorder list just has no TimesFM line.

## What it adds

On the reorder list (Inventory → Reorder list), under each item's "Suggested" reorder point, a **TimesFM** line with
the model's figure for the same quantity: demand over the next lead time + 7 days, enough in 5 of 6 cases. The
history suggestion uses only the last 90 days, so it lags behind seasons; TimesFM reads up to two years of
shipments (`server/domain/reorder-point-forecast.mjs`). The "Set reorder point…" dialog offers either figure; nothing
changes until a person confirms. The list itself is still dated by the recorded reorder point.

Backtest on public data (M5 Walmart and UCI Online Retail II, weekly review, 14-day lead time, training periods
only): at 95% fill, about the same stock as the 90-day rule for steady items (−4%, interval −8% to +1%) and 26–35%
less for seasonal ones.

## Run it

The service needs Python with PyTorch (CPU) and `timesfm` 3.x (which includes TimesFM 2.5):

    python -m venv C:\Users\<you>\fbtv              # a short path: PyTorch's files exceed Windows' 260-character limit
    C:\Users\<you>\fbtv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
    C:\Users\<you>\fbtv\Scripts\python -m pip install "timesfm[torch]==3.0.2"
    C:\Users\<you>\fbtv\Scripts\python tools/forecast-service/server.py              # port 18850
    C:\Users\<you>\fbtv\Scripts\python tools/forecast-service/server.py --self-test  # one quick forecast, then exit

The first start downloads the weights (about 0.9 GB) to the Hugging Face cache. Then start FlowChain's API with

    FLOWCHAIN_FORECAST_URL=http://127.0.0.1:18850

(`scripts/walkthrough-local.mjs` passes it through to both workspaces). Optional: `FLOWCHAIN_FORECAST_TIMEOUT_MS`
(default 30000). The first page load of a workspace forecasts every listed item, a few seconds for 200 items; the
API keeps the answers in memory, so a reload is immediate.

## API

    POST /v1/quantiles  {"series": [[number, ...], ...], "quantile": 0.8333}
      -> {"model": "google/timesfm-2.5-200m-pytorch", "quantile": 0.8333, "values": [number | null, ...]}
    GET /health         -> {"status": "ok", "model": "..."}

Each series is one item's history as equal-length period totals, oldest first; the reply is the quantile of the next
period's total. It listens on 127.0.0.1 only.
