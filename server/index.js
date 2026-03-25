const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { WebSocketServer } = require('ws');
const fs      = require('fs');

const { backfillAll, TIMEFRAMES } = require('./fetcher');
const { getCandles, getDb }       = require('./db');
const { subscribe, setOnUpdate }  = require('./stream');
const { searchMarkets, getMarkets } = require('./markets');

fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// ─── Browser WebSocket clients ────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected', timeframes: TIMEFRAMES }));
});

function broadcastTick(symbol, timeframe, candle) {
  if (!clients.size) return;
  const msg = JSON.stringify({ type: 'tick', symbol, timeframe, candle });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// Hook stream -> browser clients
setOnUpdate(broadcastTick);

// ─── REST API ──────────────────────────────────────────────────────────────────

// Candles
app.get('/api/candles', async (req, res) => {
  const { symbol = 'BTC/USDT', timeframe = '1h', limit = 500 } = req.query;
  if (!TIMEFRAMES.includes(timeframe))
    return res.status(400).json({ error: `Invalid timeframe` });
  try {
    const candles = await getCandles(symbol, timeframe, parseInt(limit));
    res.json({ symbol, timeframe, count: candles.length, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search symbols
app.get('/api/search', async (req, res) => {
  const { q = '' } = req.query;
  if (q.length < 1) return res.json({ results: [] });
  try {
    const results = await searchMarkets(q);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subscribe to a new symbol (backfill + start streaming)
app.post('/api/subscribe', async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    console.log(`[subscribe] ${symbol}`);
    await backfillAll(symbol);
    subscribe(symbol);
    res.json({ ok: true, symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/timeframes', (_, res) => res.json({ timeframes: TIMEFRAMES }));

// Multi-timeframe candles (used by client MTF signal engine)
app.get('/api/mtf', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  const MTF_TIMEFRAMES = ['15m', '1h', '4h', '1d'];
  try {
    const data = {};
    for (const tf of MTF_TIMEFRAMES) {
      data[tf] = await getCandles(symbol, tf, 200);
    }
    res.json({ symbol, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Funding rate (Binance perpetual futures)
const ccxt = require('ccxt');
const binanceFutures = new ccxt.binanceusdm({ enableRateLimit: true });
app.get('/api/funding', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  try {
    const info = await binanceFutures.fetchFundingRate(symbol);
    res.json({
      fundingRate:     info.fundingRate     ?? null,
      nextFundingTime: info.nextFundingTime ?? null,
    });
  } catch (err) {
    // Futures may not exist for all symbols — return empty rather than error
    res.json({ fundingRate: null, nextFundingTime: null });
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function boot() {
  console.log('Initializing database...');
  await getDb();
  console.log('Database ready');

  // Pre-warm market list in background
  getMarkets().catch(() => {});

  const defaultSymbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  for (const sym of defaultSymbols) {
    console.log(`Backfilling ${sym}...`);
    await backfillAll(sym);
    subscribe(sym);
  }
  console.log('Ready!');

  server.listen(PORT, () => {
    console.log(`\nServer: http://localhost:${PORT}\n`);
  });
}

boot().catch(console.error);
