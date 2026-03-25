const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '../data/candles.bin');

let db;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    try {
      const data = fs.readFileSync(DB_PATH);
      db = new SQL.Database(data);
      db.exec('PRAGMA user_version;');
    } catch (err) {
      console.error('Failed to load existing database (possibly corrupted). Initializing a new one.', err.message);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      open      REAL NOT NULL,
      high      REAL NOT NULL,
      low       REAL NOT NULL,
      close     REAL NOT NULL,
      volume    REAL NOT NULL,
      PRIMARY KEY (symbol, timeframe, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_candles ON candles(symbol, timeframe, ts);
  `);

  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function insertCandles(symbol, timeframe, candles) {
  const d = await getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO candles (symbol, timeframe, ts, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [ts, open, high, low, close, volume] of candles) {
    stmt.run([symbol, timeframe, ts, open, high, low, close, volume]);
  }
  stmt.free();
  saveDb();
}

async function getCandles(symbol, timeframe, limit = 500) {
  const d = await getDb();
  const stmt = d.prepare(`
    SELECT ts, open, high, low, close, volume
    FROM candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY ts DESC
    LIMIT ?
  `);
  stmt.bind([symbol, timeframe, limit]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.reverse();
}

async function getLatestTs(symbol, timeframe) {
  const d = await getDb();
  const stmt = d.prepare(`SELECT MAX(ts) as ts FROM candles WHERE symbol = ? AND timeframe = ?`);
  stmt.bind([symbol, timeframe]);
  let ts = null;
  if (stmt.step()) ts = stmt.getAsObject().ts;
  stmt.free();
  return ts;
}

module.exports = { getDb, insertCandles, getCandles, getLatestTs };
