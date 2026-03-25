/**
 * stream.js — Binance WebSocket kline streams
 * Connects directly to Binance WS for real-time candle updates.
 * Much faster than REST polling — updates on every tick.
 */
const WebSocket = require('ws');
const { insertCandles } = require('./db');

const BINANCE_WS = 'wss://stream.binance.com:9443/stream';
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Active streams per symbol
const activeStreams = new Map(); // symbol -> { ws, reconnectTimer }

// Callbacks to notify server of updates
let onUpdateCallback = null;

function setOnUpdate(fn) {
  onUpdateCallback = fn;
}

function symbolToStream(symbol) {
  // BTC/USDT -> btcusdt
  return symbol.replace('/', '').toLowerCase();
}

function buildStreams(symbol) {
  const base = symbolToStream(symbol);
  return TIMEFRAMES.map(tf => `${base}@kline_${tf}`);
}

async function subscribe(symbol) {
  if (activeStreams.has(symbol)) return; // already streaming

  console.log(`[stream] subscribing to ${symbol}`);
  const streams = buildStreams(symbol);
  const url = `${BINANCE_WS}?streams=${streams.join('/')}`;

  function connect() {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[stream] connected: ${symbol}`);
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        const k = msg.data?.k;
        if (!k) return;

        const timeframe = k.i; // e.g. "1m"
        const candle = [
          k.t,          // open time (ms)
          parseFloat(k.o),
          parseFloat(k.h),
          parseFloat(k.l),
          parseFloat(k.c),
          parseFloat(k.v),
        ];

        // Always upsert the current (possibly unfinished) candle
        await insertCandles(symbol, timeframe, [candle]);

        // Notify server to broadcast to browser clients
        if (onUpdateCallback) {
          onUpdateCallback(symbol, timeframe, {
            ts:     k.t,
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v),
            closed: k.x, // true if candle is final
          });
        }
      } catch (err) {
        console.error('[stream] parse error:', err.message);
      }
    });

    ws.on('error', (err) => {
      console.error(`[stream] error for ${symbol}:`, err.message);
    });

    ws.on('close', () => {
      console.log(`[stream] disconnected: ${symbol}, reconnecting in 3s...`);
      const entry = activeStreams.get(symbol);
      if (entry) {
        entry.reconnectTimer = setTimeout(connect, 3000);
      }
    });

    const entry = activeStreams.get(symbol) || {};
    entry.ws = ws;
    activeStreams.set(symbol, entry);
  }

  activeStreams.set(symbol, {});
  connect();
}

function unsubscribe(symbol) {
  const entry = activeStreams.get(symbol);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.ws) entry.ws.terminate();
  activeStreams.delete(symbol);
  console.log(`[stream] unsubscribed: ${symbol}`);
}

function getActiveSymbols() {
  return [...activeStreams.keys()];
}

module.exports = { subscribe, unsubscribe, setOnUpdate, getActiveSymbols };
