const ccxt = require('ccxt');
const { insertCandles, getLatestTs } = require('./db');

const exchange = new ccxt.binance({ enableRateLimit: true });

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const BACKFILL_LIMIT = 2000;

async function backfill(symbol, timeframe) {
  console.log(`[backfill] ${symbol} ${timeframe}`);
  try {
    const latestTs = await getLatestTs(symbol, timeframe);
    // If we have recent data (within the last 2 candle periods), skip full backfill
    const since = latestTs ? latestTs + 1 : undefined;
    const limit = latestTs ? 200 : BACKFILL_LIMIT; // smaller fetch for incremental updates
    const candles = await exchange.fetchOHLCV(symbol, timeframe, since, limit);
    if (candles.length > 0) {
      await insertCandles(symbol, timeframe, candles);
      console.log(`[backfill] ${symbol} ${timeframe}: ${candles.length} candles (since=${since ? new Date(since).toISOString() : 'start'})`);
    } else {
      console.log(`[backfill] ${symbol} ${timeframe}: already up to date`);
    }
  } catch (err) {
    console.error(`[backfill] error ${symbol} ${timeframe}:`, err.message);
  }
}

async function backfillAll(symbol) {
  for (const tf of TIMEFRAMES) {
    await backfill(symbol, tf);
  }
}

module.exports = { backfillAll, backfill, TIMEFRAMES };
