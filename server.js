const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const token = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

if (!token) { console.error("BOT_TOKEN is missing"); process.exit(1); }
if (!TWELVE_DATA_API_KEY) { console.error("TWELVE_DATA_API_KEY is missing"); process.exit(1); }

const bot = new TelegramBot(token, { polling: true });
bot.on("polling_error", e => console.error("Polling error:", e.message));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ================================================================
// ADMIN LOGIN  (FIX: no more default password)
// ================================================================
const ADMIN_USER = process.env.ADMIN_USER || "admin";
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString("hex");
  console.log("⚠️ ADMIN_PASSWORD not set. Temporary admin password for this run: " + ADMIN_PASSWORD);
}

function requireAdminAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required.");
  }
  const decoded = Buffer.from(h.split(" ")[1], "base64").toString();
  const sep = decoded.indexOf(":");
  const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const pass = sep >= 0 ? decoded.slice(sep + 1) : "";
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Invalid credentials.");
}

// ================================================================
// MARKETS
// ================================================================
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP"];
const pipSize = pair => (pair.includes("JPY") ? 0.01 : 0.0001);
const decimalsFor = pair => (pair.includes("JPY") ? 3 : 5);

// ================================================================
// SETTINGS
// ================================================================
const SETTINGS = {
  HTF_INTERVAL: "1h",
  ENTRY_INTERVAL: "15min",
  HTF_CANDLES: 120,
  ENTRY_CANDLES: 240,
  SWING_LOOKBACK: 2,
  MAX_SWEEP_AGE: 8,
  MAX_DISPLACEMENT_AFTER_SWEEP: 3,
  MAX_BOS_AFTER_DISPLACEMENT: 3,
  MAX_SETUP_AGE_BARS: 6,
  MIN_DISPLACEMENT_BODY_RATIO: 0.6,
  MIN_DISPLACEMENT_MULTIPLIER: 1.25,
  MIN_RETEST_BODY_RATIO: 0.45,
  MIN_RETEST_CLOSE_POSITION: 0.62,
  MIN_RR: 2.0,
  SL_BUFFER_PIPS: 1.5,
  MIN_TARGET_PIPS: 15,
  MAX_TARGET_PIPS: 100,
  SETUP_EXPIRY_MS: 90 * 60 * 1000,
  SIGNAL_COOLDOWN_MS: 60 * 60 * 1000,
  MIN_SIGNAL_SCORE: 78,
  // Twelve Data free plan = 8 credits/minute. 1 call for 6 pairs = 6 credits.
  API_WAIT_BETWEEN_CALLS_MS: 61 * 1000,
  // Run each cycle this long after the 15M candle closes
  CYCLE_DELAY_AFTER_CLOSE_MS: 20 * 1000
};

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

// ================================================================
// STATE
// ================================================================
const market = {};
PAIRS.forEach(pair => {
  market[pair] = {
    htfCandles: [], entryCandles: [], pendingSetup: null,
    lastSignalTime: 0, lastProcessedCandleTime: 0,
    bias: "NEUTRAL", structure: "NEUTRAL", lastPrice: null,
    lastAnalysis: "Waiting for market data", dataStatus: "WAITING",
    lastDataUpdate: 0, lastDataError: null, htfLastCandle: 0, entryLastCandle: 0
  };
});

let dataRefreshRunning = false;
const subscribers = new Map();
const unsubscribed = new Set();
const signalHistory = [];
const MAX_SIGNAL_HISTORY = 300;
const botStartedAt = Date.now();

(process.env.SIGNAL_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(id => {
  const n = Number(id);
  if (!Number.isNaN(n)) subscribers.set(n, { username: null, firstName: "Permanent", joinedAt: Date.now() });
});

function autoSubscribe(msg) {
  const id = msg.chat.id;
  if (subscribers.has(id) || unsubscribed.has(id)) return;
  subscribers.set(id, {
    username: msg.from?.username || null,
    firstName: msg.from?.first_name || "Unknown",
    joinedAt: Date.now()
  });
}

const mainMenu = {
  reply_markup: {
    keyboard: [
      ["📊 Market Status", "🔔 Auto Signals"],
      ["🔕 Stop Alerts", "📖 How It Works"],
      ["⚙️ Settings"]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

app.get("/", (req, res) => res.send("💱 FOREX SIGNAL ENGINE V3 is running."));

// ================================================================
// HELPERS
// ================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

function isValidCandle(c) {
  return Number.isFinite(c.open) && Number.isFinite(c.high) &&
    Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.time);
}

function intervalMilliseconds(interval) {
  if (interval === "15min") return QUARTER_MS;
  if (interval === "1h") return HOUR_MS;
  return 0;
}

function closedCandlesOnly(candles, interval) {
  const d = intervalMilliseconds(interval);
  if (!d) return candles;
  const now = Date.now();
  return candles.filter(c => c.time + d <= now);
}

// FIX: Twelve Data datetimes are UTC (we request timezone=UTC) - parse them as UTC
function parseUtc(dt) {
  let s = String(dt).trim();
  if (s.length <= 10) s += " 00:00:00";
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

// ================================================================
// TWELVE DATA  (FIX: detects rate-limit errors inside normal 200 responses)
// ================================================================
function isRateLimit(d) {
  if (!d || d.status !== "error") return false;
  return Number(d.code) === 429 || /credit|limit|minute/i.test(String(d.message || ""));
}

async function requestTwelveData(interval, outputsize, attempt = 1) {
  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(PAIRS.join(","))}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}&timezone=UTC` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  try {
    const response = await axios.get(url, { timeout: 25000 });
    const d = response.data;
    if (isRateLimit(d) && attempt < 3) {
      console.log(`[Twelve Data] Rate limit (${interval}). Waiting 61s, retry ${attempt}...`);
      await sleep(SETTINGS.API_WAIT_BETWEEN_CALLS_MS);
      return requestTwelveData(interval, outputsize, attempt + 1);
    }
    return d;
  } catch (error) {
    if (error.response?.status === 429 && attempt < 3) {
      console.log(`[Twelve Data] HTTP 429 (${interval}). Waiting 61s, retry ${attempt}...`);
      await sleep(SETTINGS.API_WAIT_BETWEEN_CALLS_MS);
      return requestTwelveData(interval, outputsize, attempt + 1);
    }
    throw error;
  }
}

function parsePairResponse(entry, interval) {
  if (!entry || entry.status === "error" || !Array.isArray(entry.values)) {
    return { candles: [], error: String(entry?.message || entry?.code || "No candle data returned") };
  }
  const candles = entry.values
    .map(v => ({
      open: Number(v.open), high: Number(v.high), low: Number(v.low),
      close: Number(v.close), time: parseUtc(v.datetime)
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);

  const closed = closedCandlesOnly(candles, interval);
  if (!closed.length) return { candles: [], error: "No closed candles available yet" };
  return { candles: closed, error: null };
}

async function fetchCandles(interval, outputsize) {
  let data;
  try {
    data = await requestTwelveData(interval, outputsize);
  } catch (error) {
    const message = error.response?.data?.message || error.message || "Unknown API error";
    console.error(`[${interval}] Twelve Data request failed:`, message);
    PAIRS.forEach(p => { market[p].dataStatus = "ERROR"; market[p].lastDataError = String(message); });
    return false;
  }

  // Whole-request error (bad key, rate limit after retries, etc.)
  if (data && data.status === "error" && !data[PAIRS[0]]) {
    const message = data.message || "API error";
    console.error(`[${interval}] Twelve Data error:`, message);
    PAIRS.forEach(p => { market[p].dataStatus = "ERROR"; market[p].lastDataError = String(message); });
    return false;
  }

  const ok = [];
  for (const pair of PAIRS) {
    const parsed = parsePairResponse(data?.[pair], interval);
    const st = market[pair];
    if (parsed.candles.length) {
      const last = parsed.candles[parsed.candles.length - 1].time;
      if (interval === SETTINGS.HTF_INTERVAL) { st.htfCandles = parsed.candles; st.htfLastCandle = last; }
      else { st.entryCandles = parsed.candles; st.entryLastCandle = last; }
      st.lastDataUpdate = Date.now();
      st.dataStatus = "OK";
      st.lastDataError = null;
      ok.push(pair);
    } else {
      st.dataStatus = "ERROR";
      st.lastDataError = parsed.error || "No data";
    }
  }
  console.log(`[DATA] ${interval}: ${ok.length}/${PAIRS.length} pairs loaded`);
  return ok.length > 0;
}

// FIX: 1H data only fetched when a new 1H candle should exist (saves API credits)
function needHtfRefresh() {
  const now = Date.now();
  return PAIRS.some(p => {
    const st = market[p];
    return st.htfCandles.length < 60 || now >= st.htfLastCandle + 2 * HOUR_MS;
  });
}

async function fetchAllMarketData() {
  if (dataRefreshRunning) { console.log("⏳ Data refresh already running"); return; }
  dataRefreshRunning = true;
  try {
    let fetchedHtf = false;
    if (needHtfRefresh()) {
      await fetchCandles(SETTINGS.HTF_INTERVAL, SETTINGS.HTF_CANDLES);
      fetchedHtf = true;
    }
    // FIX: wait out the per-minute credit window before the next call
    if (fetchedHtf) await sleep(SETTINGS.API_WAIT_BETWEEN_CALLS_MS);
    await fetchCandles(SETTINGS.ENTRY_INTERVAL, SETTINGS.ENTRY_CANDLES);
  } finally {
    dataRefreshRunning = false;
  }
}

// ================================================================
// SWINGS / STRUCTURE
// ================================================================
function findSwings(candles, lookback = 2) {
  const swings = [];
  if (candles.length < lookback * 2 + 3) return swings;
  for (let i = lookback; i < candles.length - lookback; i++) {
    const cur = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high > cur.high) isHigh = false;
      if (candles[j].low < cur.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: cur.high, type: "high" });
    if (isLow) swings.push({ index: i, price: cur.low, type: "low" });
  }
  return swings;
}

function getStructure(candles) {
  const swings = findSwings(candles, SETTINGS.SWING_LOOKBACK);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return { bias: "NEUTRAL" };
  const lh = highs[highs.length - 1], ph = highs[highs.length - 2];
  const ll = lows[lows.length - 1], pl = lows[lows.length - 2];
  const bullish = lh.price > ph.price && ll.price > pl.price;
  const bearish = lh.price < ph.price && ll.price < pl.price;
  return { bias: bullish ? "BULLISH" : bearish ? "BEARISH" : "NEUTRAL" };
}

function calculateEMA(candles, period) {
  if (candles.length < period) return null;
  const m = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = (candles[i].close - ema) * m + ema;
  return ema;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < period) return null;
  const recent = trs.slice(trs.length - period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function getHTFBias(candles) {
  if (candles.length < 60) return { bias: "NEUTRAL", score: 0, structure: "NEUTRAL", ema20: null, ema50: null };
  const structure = getStructure(candles);
  const ema20 = calculateEMA(candles, 20);
  const ema50 = calculateEMA(candles, 50);
  const last = candles[candles.length - 1];
  let score = 0;
  if (structure.bias === "BULLISH") score += 2;
  if (structure.bias === "BEARISH") score -= 2;
  if (ema20 && ema50) {
    if (ema20 > ema50 && last.close > ema20) score += 2;
    if (ema20 < ema50 && last.close < ema20) score -= 2;
  }
  const oldIndex = Math.max(0, candles.length - 6);
  const oldEma = calculateEMA(candles.slice(0, oldIndex + 1), 20);
  if (oldEma && ema20) {
    if (ema20 > oldEma) score += 1;
    if (ema20 < oldEma) score -= 1;
  }
  const bias = score >= 3 ? "BULLISH" : score <= -3 ? "BEARISH" : "NEUTRAL";
  return { bias, score, structure: structure.bias, ema20, ema50 };
}

// ================================================================
// CANDLE HELPERS
// ================================================================
const candleBody = c => Math.abs(c.close - c.open);
const candleRange = c => c.high - c.low;
const isBullishCandle = c => c.close > c.open;
const isBearishCandle = c => c.close < c.open;

function closePosition(c) {
  const r = candleRange(c);
  return r <= 0 ? 0.5 : (c.close - c.low) / r;
}

function averageBody(candles, endIndex, count = 10) {
  const start = Math.max(0, endIndex - count);
  const v = [];
  for (let i = start; i < endIndex; i++) v.push(candleBody(candles[i]));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

// ================================================================
// SETUP PIECES
// ================================================================
function findLiquiditySweep(candles, direction, endIndex) {
  if (endIndex < 8) return null;
  const swings = findSwings(candles.slice(0, endIndex), SETTINGS.SWING_LOOKBACK);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return null;
  const cur = candles[endIndex];

  if (direction === "bullish") {
    const t = lows[lows.length - 1];
    if (cur.low < t.price && cur.close > t.price)
      return { type: "SELL-SIDE LIQUIDITY", price: t.price, index: endIndex };
  }
  if (direction === "bearish") {
    const t = highs[highs.length - 1];
    if (cur.high > t.price && cur.close < t.price)
      return { type: "BUY-SIDE LIQUIDITY", price: t.price, index: endIndex };
  }
  return null;
}

function isDisplacement(candles, index, direction) {
  if (index < 10 || index >= candles.length) return false;
  const c = candles[index];
  const range = candleRange(c);
  if (range <= 0) return false;
  const body = candleBody(c);
  if (body / range < SETTINGS.MIN_DISPLACEMENT_BODY_RATIO) return false;
  const avg = averageBody(candles, index, 10);
  if (avg > 0 && body < avg * SETTINGS.MIN_DISPLACEMENT_MULTIPLIER) return false;
  if (direction === "bullish" && !isBullishCandle(c)) return false;
  if (direction === "bearish" && !isBearishCandle(c)) return false;
  return true;
}

function findStructureBreak(candles, direction, fromIndex) {
  const end = Math.min(candles.length - 1, fromIndex + SETTINGS.MAX_BOS_AFTER_DISPLACEMENT);
  const swings = findSwings(candles.slice(0, fromIndex), SETTINGS.SWING_LOOKBACK);
  const highs = swings.filter(s => s.type === "high");
  const lows = swings.filter(s => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return null;

  if (direction === "bullish") {
    const t = highs[highs.length - 1];
    for (let i = fromIndex + 1; i <= end; i++)
      if (candles[i].close > t.price) return { index: i, price: t.price, type: "BULLISH CHoCH/BOS" };
  }
  if (direction === "bearish") {
    const t = lows[lows.length - 1];
    for (let i = fromIndex + 1; i <= end; i++)
      if (candles[i].close < t.price) return { index: i, price: t.price, type: "BEARISH CHoCH/BOS" };
  }
  return null;
}

function findFVGAt(candles, index, direction) {
  if (index < 2) return null;
  const c1 = candles[index - 2], c3 = candles[index];
  if (direction === "bullish" && c1.high < c3.low)
    return { top: c3.low, bottom: c1.high, midpoint: (c3.low + c1.high) / 2, index };
  if (direction === "bearish" && c1.low > c3.high)
    return { top: c1.low, bottom: c3.high, midpoint: (c1.low + c3.high) / 2, index };
  return null;
}

function findSupplyDemandZone(candles, displacementIndex, direction) {
  const start = Math.max(0, displacementIndex - 6);
  for (let i = displacementIndex - 1; i >= start; i--) {
    const c = candles[i];
    if (direction === "bullish" && isBearishCandle(c))
      return { type: "DEMAND", top: c.high, bottom: c.low, index: i };
    if (direction === "bearish" && isBullishCandle(c))
      return { type: "SUPPLY", top: c.high, bottom: c.low, index: i };
  }
  return null;
}

function findOrderBlock(candles, displacementIndex, direction) {
  const z = findSupplyDemandZone(candles, displacementIndex, direction);
  if (!z) return null;
  return { top: z.top, bottom: z.bottom, index: z.index, type: direction === "bullish" ? "BULLISH OB" : "BEARISH OB" };
}

function zonesOverlap(a, b) {
  if (!a || !b) return false;
  return Math.max(a.bottom, b.bottom) <= Math.min(a.top, b.top);
}

function getEntryZone(setup) {
  const zones = [setup.supplyDemand, setup.fvg, setup.orderBlock].filter(Boolean);
  if (!zones.length) return null;
  let top = Math.min(...zones.map(z => z.top));
  let bottom = Math.max(...zones.map(z => z.bottom));
  if (bottom > top) {
    const p = setup.supplyDemand || setup.orderBlock || setup.fvg;
    top = p.top; bottom = p.bottom;
  }
  return { top, bottom, midpoint: (top + bottom) / 2 };
}

// ================================================================
// BUILD SETUP
// ================================================================
function buildSetup(pair, candles, htfBias) {
  if (candles.length < 60) return null;
  if (htfBias !== "BULLISH" && htfBias !== "BEARISH") return null;

  const direction = htfBias === "BULLISH" ? "bullish" : "bearish";
  const latestIndex = candles.length - 1;
  const searchStart = Math.max(12, latestIndex - SETTINGS.MAX_SWEEP_AGE);

  for (let sweepIndex = latestIndex; sweepIndex >= searchStart; sweepIndex--) {
    const sweep = findLiquiditySweep(candles, direction, sweepIndex);
    if (!sweep) continue;

    const maxDisp = Math.min(latestIndex, sweepIndex + SETTINGS.MAX_DISPLACEMENT_AFTER_SWEEP);
    for (let d = sweepIndex + 1; d <= maxDisp; d++) {
      if (!isDisplacement(candles, d, direction)) continue;

      const structureBreak = findStructureBreak(candles, direction, d);
      if (!structureBreak) continue;
      if (latestIndex - structureBreak.index > SETTINGS.MAX_SETUP_AGE_BARS) continue;

      const fvg = findFVGAt(candles, d, direction);
      const zone = findSupplyDemandZone(candles, d, direction);
      const ob = findOrderBlock(candles, d, direction);
      if (!zone) continue;
      if (!fvg && !ob) continue;
      if (fvg && ob && !zonesOverlap(fvg, ob)) continue;

      const setup = {
        direction, sweep, displacementIndex: d, structureBreak, fvg,
        supplyDemand: zone, orderBlock: ob,
        createdAt: Date.now(),
        createdCandleTime: candles[structureBreak.index].time,
        signalScore: 0
      };
      if (!getEntryZone(setup)) continue;
      return setup;
    }
  }
  return null;
}

// ================================================================
// RETEST / CONFIRMATION
// ================================================================
function confirmationCandle(candles, setup) {
  const zone = getEntryZone(setup);
  if (!zone) return null;
  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  if (!latest) return null;
  if (latestIndex <= setup.structureBreak.index) return null;
  if (latestIndex - setup.structureBreak.index > SETTINGS.MAX_SETUP_AGE_BARS) return null;

  const touches = latest.low <= zone.top && latest.high >= zone.bottom;
  if (!touches) return null;

  const range = candleRange(latest);
  if (range <= 0) return null;
  if (candleBody(latest) / range < SETTINGS.MIN_RETEST_BODY_RATIO) return null;

  if (setup.direction === "bullish") {
    if (!isBullishCandle(latest)) return null;
    if (closePosition(latest) < SETTINGS.MIN_RETEST_CLOSE_POSITION) return null;
    if (latest.close < zone.bottom) return null;
    return latest;
  }
  if (setup.direction === "bearish") {
    if (!isBearishCandle(latest)) return null;
    if ((latest.high - latest.close) / range < SETTINGS.MIN_RETEST_CLOSE_POSITION) return null;
    if (latest.close > zone.top) return null;
    return latest;
  }
  return null;
}

// ================================================================
// SCORE
// ================================================================
function calculateSetupScore(pair, setup, htfInfo, candles, entryPrice) {
  let score = 0;
  const reasons = [];
  const want = setup.direction === "bullish" ? "BULLISH" : "BEARISH";

  if (htfInfo.bias === want) { score += 20; reasons.push("HTF bias aligned"); }
  if (htfInfo.structure === want) { score += 10; reasons.push("HTF structure aligned"); }

  if (htfInfo.ema20 && htfInfo.ema50) {
    const aligned = setup.direction === "bullish" ? htfInfo.ema20 > htfInfo.ema50 : htfInfo.ema20 < htfInfo.ema50;
    if (aligned) { score += 10; reasons.push("EMA alignment"); }
  }
  if (setup.sweep) { score += 15; reasons.push("Liquidity sweep"); }
  if (isDisplacement(candles, setup.displacementIndex, setup.direction)) { score += 15; reasons.push("Strong displacement"); }
  if (setup.structureBreak) { score += 10; reasons.push("Structure break"); }
  if (setup.fvg) { score += 5; reasons.push("FVG"); }
  if (setup.orderBlock) { score += 5; reasons.push("Order Block"); }

  const age = candles.length - 1 - setup.structureBreak.index;
  if (age <= 2) { score += 5; reasons.push("Fresh setup"); }
  else if (age > 4) score -= 5;

  const atr = calculateATR(candles, 14);
  if (atr && entryPrice) {
    const zone = getEntryZone(setup);
    if (zone && zone.top - zone.bottom <= atr * 1.2) { score += 5; reasons.push("Clean zone size"); }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ================================================================
// TARGETS / LEVELS
// ================================================================
function findLiquidityTarget(candles, direction, entryPrice) {
  const swings = findSwings(candles, SETTINGS.SWING_LOOKBACK);
  if (!swings.length) return null;
  if (direction === "bullish") {
    const highs = swings.filter(s => s.type === "high").map(s => s.price).filter(p => p > entryPrice).sort((a, b) => a - b);
    return highs[0] || null;
  }
  const lows = swings.filter(s => s.type === "low").map(s => s.price).filter(p => p < entryPrice).sort((a, b) => b - a);
  return lows[0] || null;
}

function calculateTradeLevels(pair, setup, entryPrice, candles) {
  const pip = pipSize(pair);
  const buffer = SETTINGS.SL_BUFFER_PIPS * pip;
  const zone = getEntryZone(setup);
  if (!zone) return null;

  const stopLoss = setup.direction === "bullish"
    ? Math.min(zone.bottom, setup.sweep.price) - buffer
    : Math.max(zone.top, setup.sweep.price) + buffer;

  const risk = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;

  const liquidityTarget = findLiquidityTarget(candles, setup.direction, entryPrice);
  let takeProfit = liquidityTarget;
  const requiredReward = risk * SETTINGS.MIN_RR;

  if (setup.direction === "bullish") {
    if (!takeProfit || takeProfit < entryPrice + requiredReward) takeProfit = entryPrice + requiredReward;
  } else {
    if (!takeProfit || takeProfit > entryPrice - requiredReward) takeProfit = entryPrice - requiredReward;
  }

  const reward = Math.abs(takeProfit - entryPrice);
  const rr = reward / risk;
  const targetPips = reward / pip;

  if (rr < SETTINGS.MIN_RR) return null;
  if (targetPips < SETTINGS.MIN_TARGET_PIPS) return null;
  if (targetPips > SETTINGS.MAX_TARGET_PIPS) return null;

  return { stopLoss, takeProfit, risk, reward, targetPips, rr, liquidityTarget: liquidityTarget || null };
}

// ================================================================
// SIGNALS
// ================================================================
const hasOpenSignal = pair => signalHistory.some(s => s.pair === pair && s.status === "open");

function broadcast(text) {
  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, text).catch(err => console.error(`Send failed ${chatId}:`, err.message));
  }
}

function fireSignal(pair, setup, confirmation, htfInfo) {
  const state = market[pair];
  const entryPrice = confirmation.close;

  if (Date.now() - state.lastSignalTime < SETTINGS.SIGNAL_COOLDOWN_MS) { state.lastAnalysis = "Cooldown active"; return false; }
  if (hasOpenSignal(pair)) { state.lastAnalysis = "Signal already open"; return false; }

  const candles = state.entryCandles;
  const scoreData = calculateSetupScore(pair, setup, htfInfo, candles, entryPrice);
  setup.signalScore = scoreData.score;

  if (scoreData.score < SETTINGS.MIN_SIGNAL_SCORE) {
    state.lastAnalysis = `Setup rejected - score ${scoreData.score}/100`;
    console.log(`[${pair}] Setup rejected: score ${scoreData.score}`);
    return false;
  }

  const levels = calculateTradeLevels(pair, setup, entryPrice, candles);
  if (!levels) {
    state.lastAnalysis = "Setup rejected - bad target/RR";
    console.log(`[${pair}] Setup rejected: bad target/RR`);
    return false;
  }

  const direction = setup.direction === "bullish" ? "BUY" : "SELL";
  const emoji = direction === "BUY" ? "🟢" : "🔴";
  const dec = decimalsFor(pair);
  const score = scoreData.score;
  const confidence = score >= 90 ? "🔥 VERY HIGH" : score >= 85 ? "🟢 HIGH" : "🟡 GOOD";

  const message =
`🚨 ${pair} FOREX SIGNAL V3

${emoji} ${direction}
ENTRY: ${entryPrice.toFixed(dec)}

🛡️ SL:
${levels.stopLoss.toFixed(dec)}

🎯 TP:
${levels.takeProfit.toFixed(dec)}

📐 R:R
1:${levels.rr.toFixed(2)}

⭐ SETUP SCORE
${score}/100 — ${confidence}

🧠 CONFIRMATION
• 1H bias: ${state.bias}
• 1H structure: ${htfInfo.structure}
• Liquidity sweep: ✅
• Displacement: ✅
• BOS/CHoCH: ✅
• Supply/Demand: ${setup.supplyDemand?.type || "ZONE"}
• FVG: ${setup.fvg ? "✅" : "—"}
• Order Block: ${setup.orderBlock ? "✅" : "—"}
• Retest: ✅
• Confirmation candle: ✅

🎯 Target:
${levels.targetPips.toFixed(1)} pips

⚠️ Risk only what you can afford to lose.
No strategy guarantees a winning trade.`;

  const signal = {
    id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    pair, time: Date.now(),
    entryCandleTime: confirmation.time, // FIX: used to track result from the right candle
    label: setup.structureBreak.type,
    direction, entryPrice,
    stopLoss: levels.stopLoss, takeProfit: levels.takeProfit,
    targetPips: levels.targetPips, rr: levels.rr, score,
    status: "open", closedAt: null, closePrice: null, resultR: null,
    setupDetails: {
      bias: state.bias, htfStructure: htfInfo?.structure || "NEUTRAL",
      sweep: setup.sweep?.type, zone: setup.supplyDemand?.type,
      fvg: !!setup.fvg, orderBlock: !!setup.orderBlock, scoreReasons: scoreData.reasons
    }
  };

  signalHistory.unshift(signal);
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

  state.lastSignalTime = Date.now();
  state.lastAnalysis = `SIGNAL FIRED ${direction} ${score}/100`;
  console.log(`[SIGNAL] ${pair} ${direction} @ ${entryPrice} score=${score} RR=${levels.rr.toFixed(2)}`);
  broadcast(message);
  return true;
}

// ================================================================
// ANALYZE
// ================================================================
function analyzePair(pair) {
  const state = market[pair];
  const htf = state.htfCandles;
  const candles = state.entryCandles;

  if (htf.length < 60 || candles.length < 80) {
    state.lastAnalysis = `Building history (1H ${htf.length}/60, 15M ${candles.length}/80)`;
    if (!state.lastDataError && state.dataStatus !== "OK") state.dataStatus = "LOADING";
    return;
  }

  const latest = candles[candles.length - 1];
  state.lastPrice = latest.close;

  if (latest.time === state.lastProcessedCandleTime) return;
  state.lastProcessedCandleTime = latest.time;

  const htfInfo = getHTFBias(htf);
  state.bias = htfInfo.bias;
  state.structure = getStructure(candles).bias;

  if (state.pendingSetup) {
    const setup = state.pendingSetup;
    if (Date.now() - setup.createdAt > SETTINGS.SETUP_EXPIRY_MS) {
      state.pendingSetup = null; state.lastAnalysis = "Setup expired"; return;
    }
    const required = setup.direction === "bullish" ? "BULLISH" : "BEARISH";
    if (htfInfo.bias !== required) {
      state.pendingSetup = null; state.lastAnalysis = "Setup cancelled - HTF bias changed"; return;
    }
    const confirmation = confirmationCandle(candles, setup);
    if (confirmation) {
      fireSignal(pair, setup, confirmation, htfInfo);
      state.pendingSetup = null;
      return;
    }
    state.lastAnalysis = `WAITING for ${setup.direction.toUpperCase()} retest`;
    return;
  }

  if (hasOpenSignal(pair)) { state.lastAnalysis = "Signal open - tracking"; return; }

  if (htfInfo.bias !== "BULLISH" && htfInfo.bias !== "BEARISH") {
    state.lastAnalysis = "NO TRADE - HTF neutral"; return;
  }

  const setup = buildSetup(pair, candles, htfInfo.bias);
  if (!setup) {
    state.lastAnalysis = "NO TRADE - waiting for fresh liquidity + displacement + BOS"; return;
  }

  state.pendingSetup = setup;
  state.lastAnalysis = `SETUP FOUND - waiting for ${setup.supplyDemand?.type || "ZONE"} retest`;
  console.log(`[${pair}] Fresh ${setup.direction.toUpperCase()} setup found`);
}

// ================================================================
// RESULT TRACKER  (FIX: checks every candle since entry, not just the last)
// ================================================================
function checkOpenSignals() {
  const open = signalHistory.filter(s => s.status === "open");

  for (const signal of open) {
    const state = market[signal.pair];
    if (!state || !state.entryCandles.length) continue;

    const after = state.entryCandles.filter(c => c.time > signal.entryCandleTime);
    let result = null;

    for (const c of after) {
      const hitTP = signal.direction === "BUY" ? c.high >= signal.takeProfit : c.low <= signal.takeProfit;
      const hitSL = signal.direction === "BUY" ? c.low <= signal.stopLoss : c.high >= signal.stopLoss;
      // Conservative: if both hit inside one candle, count the loss
      if (hitSL) { result = "loss"; break; }
      if (hitTP) { result = "win"; break; }
    }
    if (!result) continue;

    signal.status = result;
    signal.closePrice = result === "win" ? signal.takeProfit : signal.stopLoss;
    signal.resultR = result === "win" ? signal.rr : -1;
    signal.closedAt = Date.now();
    state.lastSignalTime = Date.now();

    const dec = decimalsFor(signal.pair);
    const isWin = result === "win";

    const text =
`${isWin ? "🏆" : "🔴"} ${signal.pair} SIGNAL RESULT

${isWin ? "TAKE PROFIT HIT" : "STOP LOSS HIT"}

${signal.direction}
Entry: ${signal.entryPrice.toFixed(dec)}
Closed: ${signal.closePrice.toFixed(dec)}

⭐ Setup Score:
${signal.score}/100

📐 R:
${isWin ? "+" + signal.resultR.toFixed(2) + "R" : "-1R"}

📊 RESULT:
${isWin ? "WIN ✅" : "LOSS ❌"}`;

    console.log(`[RESULT] ${signal.pair} ${signal.direction} -> ${result.toUpperCase()}`);
    broadcast(text);
  }
}

// ================================================================
// STATS
// ================================================================
function getStats() {
  const wins = signalHistory.filter(s => s.status === "win");
  const losses = signalHistory.filter(s => s.status === "loss");
  const decided = wins.length + losses.length;
  const winRate = decided ? (wins.length / decided) * 100 : 0;
  const totalR = [...wins, ...losses].reduce((sum, s) => sum + Number(s.resultR || 0), 0);
  const grossProfit = wins.reduce((s, x) => s + Number(x.resultR || 0), 0);
  const grossLoss = losses.reduce((s, x) => s + Math.abs(Number(x.resultR || 0)), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let cur = 0, maxLossStreak = 0;
  [...wins, ...losses].sort((a, b) => a.time - b.time).forEach(s => {
    if (s.status === "loss") { cur++; maxLossStreak = Math.max(maxLossStreak, cur); } else cur = 0;
  });

  return {
    wins: wins.length, losses: losses.length, decided, winRate, totalR, profitFactor, maxLossStreak,
    open: signalHistory.filter(s => s.status === "open").length
  };
}

// ================================================================
// MAIN LOOP  (FIX: runs just after each 15M candle closes)
// ================================================================
async function runCycle() {
  try {
    console.log("==========================================");
    console.log("🔄 Refreshing forex market data...");
    await fetchAllMarketData();
    checkOpenSignals();
    PAIRS.forEach(analyzePair);
    console.log(`[CYCLE] ${new Date().toISOString()}`);
    PAIRS.forEach(pair => {
      const s = market[pair];
      console.log(`${pair} | ${s.dataStatus} | 1H=${s.htfCandles.length} 15M=${s.entryCandles.length} | Price=${s.lastPrice || "-"} | Bias=${s.bias} | ${s.lastAnalysis}${s.lastDataError ? " | ERR: " + s.lastDataError : ""}`);
    });
  } catch (error) {
    console.error("Market cycle error:", error.response?.data || error.message);
  }
}

function scheduleNextCycle() {
  const now = Date.now();
  const nextClose = Math.ceil((now + 1) / QUARTER_MS) * QUARTER_MS;
  const delay = nextClose + SETTINGS.CYCLE_DELAY_AFTER_CLOSE_MS - now;
  setTimeout(async () => {
    await runCycle();
    scheduleNextCycle();
  }, delay);
}

// First load immediately, then follow the 15M candle clock
runCycle().finally(scheduleNextCycle);

// ================================================================
// TELEGRAM
// ================================================================
bot.onText(/\/start/, msg => {
  unsubscribed.delete(msg.chat.id);
  autoSubscribe(msg);
  bot.sendMessage(msg.chat.id,
`💱 FOREX SIGNALS BOT V3

Welcome 👋

Markets:
• EUR/USD
• GBP/USD
• USD/JPY
• AUD/USD
• USD/CAD
• EUR/GBP

🧠 V3 HIGH-CONFLUENCE ENGINE

1️⃣ 1H directional bias
2️⃣ 1H structure
3️⃣ EMA alignment
4️⃣ 15M liquidity sweep
5️⃣ Displacement
6️⃣ BOS / CHoCH
7️⃣ Fresh Supply/Demand
8️⃣ FVG / Order Block
9️⃣ Retest
🔟 Confirmation candle
1️⃣1️⃣ Setup quality score
1️⃣2️⃣ Minimum 1:2 RR

🚫 Weak setups are rejected.
🎯 Signals are selective.
🛡️ Structure-based SL.
📊 Results are tracked automatically.

🔔 Automatic alerts are ON.`, mainMenu);
});

bot.on("message", async msg => {
  if (!msg.text) return;
  const id = msg.chat.id;
  const text = msg.text;

  if (text === "🔕 Stop Alerts") {
    subscribers.delete(id);
    unsubscribed.add(id);
    return bot.sendMessage(id, "🔕 Alerts stopped. Press 🔔 Auto Signals to turn them back on.", mainMenu);
  }

  if (text === "🔔 Auto Signals") {
    unsubscribed.delete(id);
    autoSubscribe(msg);
    return bot.sendMessage(id, "🔔 Automatic signals are ON.", mainMenu);
  }

  autoSubscribe(msg);

  if (text === "📊 Market Status") {
    const lines = PAIRS.map(pair => {
      const s = market[pair];
      if (s.dataStatus === "ERROR" && (s.htfCandles.length < 60 || s.entryCandles.length < 80))
        return `${pair}: ❌ ${s.lastDataError || "API ERROR"}`;
      if (s.htfCandles.length < 60 || s.entryCandles.length < 80)
        return `${pair}: ⏳ Building history (1H ${s.htfCandles.length}/60, 15M ${s.entryCandles.length}/80)`;
      if (hasOpenSignal(pair)) return `${pair}: 📈 SIGNAL ACTIVE | ${s.bias}`;
      if (s.pendingSetup)
        return `${pair}: 👀 ${s.pendingSetup.direction.toUpperCase()} SETUP | ${s.pendingSetup.supplyDemand?.type || "ZONE"}`;
      return `${pair}: 🔎 ${s.bias} | ${s.lastAnalysis}`;
    });

    bot.sendMessage(id,
`📊 FOREX MARKET STATUS V3

${lines.join("\n")}

⏱️ Checked after every 15M candle close

🚫 NO TRADE means the engine did not find enough confirmation.
⭐ The bot does NOT force trades.`);
  }

  if (text === "📖 How It Works") {
    bot.sendMessage(id,
`📖 FOREX SIGNAL ENGINE V3

The engine is deliberately selective.

🧠 STEP 1
1H determines the directional bias.

💧 STEP 2
15M waits for liquidity to be taken.

⚡ STEP 3
A strong displacement candle must appear.

🔄 STEP 4
Price must break structure.

🟦 STEP 5
The move must create a valid Supply/Demand zone, FVG or Order Block.

↩️ STEP 6
Price must return to the fresh zone.

✅ STEP 7
A confirmation candle must reject the zone.

⭐ STEP 8
The setup receives a quality score.

📐 STEP 9
The trade must have at least 1:2 risk/reward.

🚫 If the conditions are not strong enough:

NO TRADE

The engine does not manufacture signals.`);
  }

  if (text === "⚙️ Settings") {
    const counts = PAIRS.map(p => `${p}: ${market[p].htfCandles.length} × 1H, ${market[p].entryCandles.length} × 15M`).join("\n");
    bot.sendMessage(id,
`⚙️ FOREX ENGINE V3

📊 Markets
${PAIRS.join(", ")}

🧠 Higher Timeframe
1H

📈 Entry Timeframe
15M

⭐ Minimum Setup Score
${SETTINGS.MIN_SIGNAL_SCORE}/100

📐 Minimum R:R
1:${SETTINGS.MIN_RR}

🎯 Target Range
${SETTINGS.MIN_TARGET_PIPS}-${SETTINGS.MAX_TARGET_PIPS} pips

🛡️ SL Buffer
${SETTINGS.SL_BUFFER_PIPS} pips

🔔 Alerts
${subscribers.has(id) ? "ON" : "OFF"}

📊 HISTORY
${counts}`);
  }
});

// ================================================================
// ADMIN PANEL
// ================================================================
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUptime(ms) {
  const m = Math.floor(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

app.get("/admin", requireAdminAuth, (req, res) => {
  const stats = getStats();

  const pairRows = PAIRS.map(pair => {
    const s = market[pair];
    const dec = decimalsFor(pair);
    let status;
    if (s.dataStatus === "ERROR" && s.entryCandles.length < 80) status = `❌ ${escapeHtml(s.lastDataError || "API ERROR")}`;
    else if (hasOpenSignal(pair)) status = "📈 SIGNAL OPEN";
    else if (s.pendingSetup) status = `👀 ${escapeHtml(s.pendingSetup.direction)} ${s.pendingSetup.supplyDemand?.type || "ZONE"}`;
    else status = `🔎 ${escapeHtml(s.lastAnalysis)}`;
    return `<tr><td>${pair}</td><td>${s.lastPrice !== null ? s.lastPrice.toFixed(dec) : "—"}</td><td>${escapeHtml(s.bias)}</td><td>${escapeHtml(s.structure)}</td><td>${status}</td><td>${s.htfCandles.length} / ${s.entryCandles.length}</td></tr>`;
  }).join("");

  const subscriberRows = [...subscribers.entries()].map(([chatId, info]) =>
    `<tr><td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td><td>${chatId}</td><td>${new Date(info.joinedAt).toLocaleString()}</td><td><form method="POST" action="/admin/remove" style="margin:0;"><input type="hidden" name="chatId" value="${chatId}"><button type="submit" class="danger">Remove</button></form></td></tr>`
  ).join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const badge = { open: "⏳ Open", win: "🏆 Win", loss: "❌ Loss" };

  const signalRows = signalHistory.slice(0, 50).map(s => {
    const dec = decimalsFor(s.pair);
    const r = s.resultR === null || s.resultR === undefined ? "—" : (s.resultR >= 0 ? "+" : "") + s.resultR.toFixed(2) + "R";
    return `<tr><td>${new Date(s.time).toLocaleString()}</td><td>${s.pair}</td><td>${escapeHtml(s.label)}</td><td>${s.direction}</td><td>${s.entryPrice.toFixed(dec)}</td><td>${s.stopLoss.toFixed(dec)}</td><td>${s.takeProfit.toFixed(dec)}</td><td>${badge[s.status] || s.status}</td><td>${s.score || "—"}</td><td>${r}</td></tr>`;
  }).join("") || `<tr><td colspan="10">No signals fired yet.</td></tr>`;

  const card = (label, value) => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`;

  res.send(`<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Forex Signals V3 - Admin</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#0f1115;color:#eee;margin:0;padding:16px}
h1{font-size:1.3rem} h2{font-size:1.05rem;margin-top:28px;color:#f5c542}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.card{background:#1b1f27;border-radius:10px;padding:12px 16px;flex:1 1 140px}
.card .label{font-size:.75rem;color:#999} .card .value{font-size:1.3rem;font-weight:bold;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:.82rem}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid #2a2f3a;white-space:nowrap}
th{color:#aaa;font-weight:normal}
button{background:#2b6fe0;color:#fff;border:none;padding:8px 14px;border-radius:6px;font-size:.85rem}
button.danger{background:#c0392b}
textarea{width:100%;box-sizing:border-box;background:#1b1f27;color:#eee;border:1px solid #333;border-radius:6px;padding:8px;font-size:.9rem}
.scroll{overflow-x:auto}
.note{background:#171b22;padding:12px;border-radius:8px;margin:10px 0;line-height:1.5}
</style></head><body>
<h1>💱 Forex Signals Engine V3</h1>
<div class="note"><b>Strategy:</b> 1H Bias → 1H Structure → EMA → Liquidity Sweep → Displacement → BOS/CHoCH → Fresh Zone → FVG/OB → Retest → Confirmation → Score → Minimum 1:2 RR</div>
<div class="stats">
${card("Bot uptime", formatUptime(Date.now() - botStartedAt))}
${card("Subscribers", subscribers.size)}
${card("Signals", signalHistory.length)}
</div>
<div class="stats">
${card("Win rate", stats.decided ? stats.winRate.toFixed(1) + "%" : "—")}
${card("Total R", (stats.totalR >= 0 ? "+" : "") + stats.totalR.toFixed(2) + "R")}
${card("Profit factor", stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2))}
${card("Max loss streak", stats.maxLossStreak)}
${card("Wins", stats.wins)}
${card("Losses", stats.losses)}
${card("Open", stats.open)}
</div>
<h2>Markets</h2>
<div class="scroll"><table>
<tr><th>Pair</th><th>Price</th><th>1H Bias</th><th>15M Structure</th><th>Status</th><th>Candles 1H / 15M</th></tr>
${pairRows}
</table></div>
<h2>Broadcast</h2>
<form method="POST" action="/admin/broadcast">
<textarea name="message" rows="3" placeholder="Type a message..."></textarea><br><br>
<button type="submit">Send Broadcast</button>
</form>
<h2>Subscribers (${subscribers.size})</h2>
<div class="scroll"><table>
<tr><th>Name</th><th>Chat ID</th><th>Joined</th><th>Action</th></tr>
${subscriberRows}
</table></div>
<h2>Recent Signals</h2>
<div class="scroll"><table>
<tr><th>Time</th><th>Pair</th><th>Type</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th><th>Score</th><th>R</th></tr>
${signalRows}
</table></div>
</body></html>`);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  const id = Number(req.body.chatId);
  subscribers.delete(id);
  unsubscribed.add(id);
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, (req, res) => {
  const message = (req.body.message || "").trim();
  if (message) broadcast(`📢 ${message}`);
  res.redirect("/admin");
});

// ================================================================
// SHUTDOWN / START
// ================================================================
async function shutdown() {
  try { await bot.stopPolling(); } catch (err) { console.error("Error stopping polling:", err.message); }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, () => {
  console.log(`💱 FOREX SIGNALS BOT V3 running on port ${PORT}`);
  console.log(`📊 Markets: ${PAIRS.join(", ")}`);
  console.log(`⭐ Minimum score: ${SETTINGS.MIN_SIGNAL_SCORE}/100 | 📐 Minimum RR: 1:${SETTINGS.MIN_RR}`);
});
