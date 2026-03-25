/**
 * markets.js — fetch and cache all Binance USDT spot markets
 */
const ccxt = require('ccxt');
const exchange = new ccxt.binance({ enableRateLimit: true });

let marketList = []; // [{ symbol, base, quote, volume }]
let lastFetch = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getMarkets() {
  if (marketList.length && Date.now() - lastFetch < CACHE_TTL) return marketList;

  console.log('[markets] fetching market list from Binance...');
  try {
    await exchange.loadMarkets();
    const tickers = await exchange.fetchTickers();

    marketList = Object.values(exchange.markets)
      .filter(m => m.active && m.quote === 'USDT' && m.spot)
      .map(m => {
        const ticker = tickers[m.symbol];
        return {
          symbol:    m.symbol,
          base:      m.base,
          quote:     m.quote,
          price:     ticker?.last || 0,
          volume24h: ticker?.quoteVolume || 0,
        };
      })
      .sort((a, b) => b.volume24h - a.volume24h);

    lastFetch = Date.now();
    console.log(`[markets] loaded ${marketList.length} USDT markets`);
  } catch (err) {
    console.error('[markets] error:', err.message);
  }

  return marketList;
}

async function searchMarkets(query) {
  const markets = await getMarkets();
  const q = query.toUpperCase().replace('/', '').replace('USDT', '');
  return markets
    .filter(m => m.base.includes(q) || m.symbol.includes(q))
    .slice(0, 20);
}

module.exports = { getMarkets, searchMarkets };
