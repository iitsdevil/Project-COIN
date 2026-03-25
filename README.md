# Binance OHLCV Analyzer

A personal trading analysis dashboard pulling real candle data from Binance.

## Features
- 📊 Live candlestick chart (TradingView Lightweight Charts)
- ⏱ Multiple timeframes: 1m, 5m, 15m, 1h, 4h, 1d
- 🔄 Real-time updates via WebSocket
- 💾 Local SQLite storage (no data loss on restart)
- 📈 Session stats, recent candle list, volume histogram
- 🪙 BTC/USDT, ETH/USDT, SOL/USDT support

## Setup

```bash
# Install dependencies
npm install

# Start the server (backfills 500 candles per timeframe on first run)
npm start

# Dev mode (auto-restart)
npm run dev
```

Then open **http://localhost:3000** in your browser.

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/candles?symbol=BTC/USDT&timeframe=1h&limit=500` | Fetch candles |
| `GET /api/timeframes` | List available timeframes |
| `GET /api/symbols` | List tracked symbols |

## Adding More Symbols

In `server/fetcher.js`, update `backfillAll()` calls in `server/index.js`:
```js
await backfillAll('ETH/USDT');
await backfillAll('SOL/USDT');
```

## Adding More Exchanges

CCXT supports 100+ exchanges. Swap in `server/fetcher.js`:
```js
const exchange = new ccxt.bybit({ enableRateLimit: true });
// or: ccxt.kraken, ccxt.coinbase, ccxt.okx ...
```

## Project Structure
```
├── server/
│   ├── index.js      ← Express server + WebSocket
│   ├── fetcher.js    ← CCXT backfill + polling
│   └── db.js         ← SQLite storage layer
├── client/
│   └── index.html    ← Chart frontend (self-contained)
├── data/
│   └── candles.db    ← Created automatically
└── package.json
```
