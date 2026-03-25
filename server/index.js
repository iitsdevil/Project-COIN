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
    res.json({ fundingRate: null, nextFundingTime: null });
  }
});

// Open Interest
app.get('/api/openinterest', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  try {
    const info = await binanceFutures.fetchOpenInterest(symbol);
    res.json({ openInterest: info.openInterestAmount ?? null, symbol });
  } catch (err) {
    res.json({ openInterest: null });
  }
});

// Long/Short Ratio (top traders accounts)
app.get('/api/longshortratio', async (req, res) => {
  const { symbol = 'BTC/USDT' } = req.query;
  try {
    // Convert BTC/USDT -> BTCUSDT for Binance REST call
    const pair = symbol.replace('/', '');
    const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=5m&limit=1`;
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(url, r => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
    if (Array.isArray(data) && data[0]) {
      const ratio = parseFloat(data[0].longShortRatio);
      const longPct = (ratio / (1 + ratio) * 100).toFixed(1);
      const shortPct = (100 - longPct).toFixed(1);
      res.json({ longPct, shortPct, ratio });
    } else {
      res.json({ longPct: null, shortPct: null });
    }
  } catch (err) {
    res.json({ longPct: null, shortPct: null });
  }
});

// Backtest — replay signal engine over stored candles
app.get('/api/backtest', async (req, res) => {
  const { symbol = 'BTC/USDT', timeframe = '1h' } = req.query;
  try {
    const candles = await getCandles(symbol, timeframe, 2000);
    if (candles.length < 60) return res.json({ error: 'Not enough candle data' });

    // Inline mini signal engine (score only)
    function ema(arr, p) {
      const k = 2 / (p + 1); let e = null; return arr.map(v => {
        if (e === null) { e = v; return null; } e = v * k + e * (1 - k); return e;
      });
    }
    function rsi(arr, p = 14) {
      let ag = 0, al = 0;
      for (let i = 1; i <= p; i++) { const d = arr[i] - arr[i-1]; if (d > 0) ag += d; else al -= d; }
      ag /= p; al /= p;
      return arr.map((_, i) => {
        if (i < p) return null;
        if (i > p) { const d = arr[i] - arr[i-1]; ag = (ag*(p-1)+(d>0?d:0))/p; al = (al*(p-1)+(d<0?-d:0))/p; }
        return al === 0 ? 100 : 100 - 100/(1 + ag/al);
      });
    }

    const closes = candles.map(c => +c.close);
    const e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
    const rsiArr = rsi(closes, 14);

    const trades = [];
    const WINDOW = 50;
    for (let i = WINDOW; i < candles.length - 5; i++) {
      const price = closes[i];
      if (!e20[i] || !e50[i] || !e200[i] || rsiArr[i] == null) continue;
      let score = 0;
      if (price > e20[i] && e20[i] > e50[i] && e50[i] > e200[i]) score += 2;
      else if (price < e20[i] && e20[i] < e50[i] && e50[i] < e200[i]) score -= 2;
      const rv = rsiArr[i];
      if (rv < 30) score += 2; else if (rv > 70) score -= 2;
      else if (rv < 40) score -= 0.5; else if (rv > 60) score += 0.5;

      if (Math.abs(score) < 2.5) continue; // skip low confidence
      const direction = score > 0 ? 'BUY' : 'SELL';

      // Check outcome over next 5 candles
      const exitPrice = closes[i + 5];
      const pnl = direction === 'BUY' ? (exitPrice - price) / price * 100 : (price - exitPrice) / price * 100;
      trades.push({ direction, entry: price, exit: exitPrice, pnl: Math.round(pnl * 100) / 100 });
    }

    if (!trades.length) return res.json({ error: 'No signals generated' });
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const maxDrawdown = Math.min(...trades.map(t => t.pnl));
    const winRate = (wins.length / trades.length * 100).toFixed(1);

    res.json({
      symbol, timeframe,
      totalTrades: trades.length,
      winRate: +winRate,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      expectancy: Math.round(((avgWin * wins.length) + (avgLoss * losses.length)) / trades.length * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
