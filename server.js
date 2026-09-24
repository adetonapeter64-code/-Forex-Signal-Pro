const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.BOT_TOKEN;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

if (!token) {
  console.error("BOT_TOKEN is missing");
  process.exit(1);
}

if (!TWELVE_DATA_API_KEY) {
  console.error("TWELVE_DATA_API_KEY is missing");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: true
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());


// ================================================================
// ADMIN LOGIN
// ================================================================

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required.");
  }

  const decoded = Buffer
    .from(authHeader.split(" ")[1], "base64")
    .toString();

  const [user, pass] = decoded.split(":");

  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Invalid credentials.");
}


// ================================================================
// MARKETS
// ================================================================

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD",
  "USD/CAD",
  "EUR/GBP"
];

function pipSize(pair) {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

function decimalsFor(pair) {
  return pair.includes("JPY") ? 3 : 5;
}


// ================================================================
// STRATEGY SETTINGS
// ================================================================

const SETTINGS = {

  // Historical candles
  HTF_INTERVAL: "1h",
  ENTRY_INTERVAL: "15min",

  HTF_CANDLES: 100,
  ENTRY_CANDLES: 150,

  // Swing detection
  SWING_LOOKBACK: 2,

  // Minimum displacement candle body
  MIN_DISPLACEMENT_BODY_RATIO: 0.55,

  // Minimum body relative to recent average body
  MIN_DISPLACEMENT_MULTIPLIER: 1.15,

  // How far a setup can remain alive
  SETUP_EXPIRY_MS: 2 * 60 * 60 * 1000,

  // Cooldown after completed signal
  SIGNAL_COOLDOWN_MS: 30 * 60 * 1000,

  // Minimum reward/risk
  MIN_RR: 1.8,

  // Maximum spread-like buffer around SL
  SL_BUFFER_PIPS: 2,

  // Minimum target
  MIN_TARGET_PIPS: 25,

  // Maximum target
  MAX_TARGET_PIPS: 100
};


// ================================================================
// MARKET STATE
// ================================================================

const market = {};

PAIRS.forEach(pair => {

  market[pair] = {

    htfCandles: [],
    entryCandles: [],

    pendingSetup: null,

    lastSignalTime: 0,

    lastProcessedCandleTime: 0,

    bias: "NEUTRAL",

    structure: "NEUTRAL",

    lastPrice: null,

    lastAnalysis: "Waiting for data"
  };

});


// ================================================================
// USERS
// ================================================================

const subscribers = new Map();

const signalHistory = [];

const MAX_SIGNAL_HISTORY = 200;

const botStartedAt = Date.now();


// ================================================================
// PERMANENT CHAT IDS
// ================================================================

(process.env.SIGNAL_CHAT_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .forEach(id => {

    subscribers.set(Number(id), {

      username: null,

      firstName: "Permanent",

      joinedAt: Date.now()

    });

  });


function autoSubscribe(msg) {

  const id = msg.chat.id;

  if (subscribers.has(id)) return;

  subscribers.set(id, {

    username: msg.from?.username || null,

    firstName: msg.from?.first_name || "Unknown",

    joinedAt: Date.now()

  });

}


// ================================================================
// TELEGRAM MENU
// ================================================================

const mainMenu = {

  reply_markup: {

    keyboard: [

      ["📊 Market Status", "📖 How It Works"],

      ["⚙️ Settings"]

    ],

    resize_keyboard: true,

    is_persistent: true

  }

};


// ================================================================
// WEB SERVER
// ================================================================

app.get("/", (req, res) => {

  res.send("💱 FOREX SIGNAL ENGINE V2 is running.");

});


// ================================================================
// TWELVE DATA FETCH
// ================================================================

async function fetchCandles(interval, outputsize) {

  const symbolParam = PAIRS.join(",");

  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbolParam)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    `&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await axios.get(url, {

    timeout: 20000

  });

  const data = response.data;

  const perSymbol =
    PAIRS.length === 1
      ? { [PAIRS[0]]: data }
      : data;

  for (const pair of PAIRS) {

    const entry = perSymbol[pair];

    if (
      !entry ||
      entry.status === "error" ||
      !Array.isArray(entry.values)
    ) {

      console.error(
        `[${pair}] ${interval} data error:`,
        entry?.message || "No values"
      );

      continue;

    }

    const candles = entry.values

      .map(v => ({

        open: Number(v.open),

        high: Number(v.high),

        low: Number(v.low),

        close: Number(v.close),

        time: new Date(v.datetime).getTime()

      }))

      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        Number.isFinite(c.time)
      )

      .sort((a, b) => a.time - b.time);

    if (interval === SETTINGS.HTF_INTERVAL) {

      market[pair].htfCandles = candles;

    } else {

      market[pair].entryCandles = candles;

    }

  }

}


// ================================================================
// LOAD ALL MARKET DATA
// ================================================================

async function fetchAllMarketData() {

  await fetchCandles(
    SETTINGS.HTF_INTERVAL,
    SETTINGS.HTF_CANDLES
  );

  await fetchCandles(
    SETTINGS.ENTRY_INTERVAL,
    SETTINGS.ENTRY_CANDLES
  );

}


// ================================================================
// SWING DETECTION
// ================================================================

function findSwings(candles, lookback = 2) {

  const swings = [];

  if (candles.length < lookback * 2 + 3) {
    return swings;
  }

  for (
    let i = lookback;
    i < candles.length - lookback;
    i++
  ) {

    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (
      let j = i - lookback;
      j <= i + lookback;
      j++
    ) {

      if (j === i) continue;

      if (candles[j].high > current.high) {
        isHigh = false;
      }

      if (candles[j].low < current.low) {
        isLow = false;
      }

    }

    if (isHigh) {

      swings.push({

        index: i,

        price: current.high,

        type: "high"

      });

    }

    if (isLow) {

      swings.push({

        index: i,

        price: current.low,

        type: "low"

      });

    }

  }

  return swings;

}


// ================================================================
// MARKET STRUCTURE
// ================================================================

function getStructure(candles) {

  const swings = findSwings(
    candles,
    SETTINGS.SWING_LOOKBACK
  );

  const highs = swings.filter(
    s => s.type === "high"
  );

  const lows = swings.filter(
    s => s.type === "low"
  );

  if (highs.length < 2 || lows.length < 2) {

    return {

      bias: "NEUTRAL",

      lastHigh: null,

      previousHigh: null,

      lastLow: null,

      previousLow: null

    };

  }

  const lastHigh = highs[highs.length - 1];

  const previousHigh = highs[highs.length - 2];

  const lastLow = lows[lows.length - 1];

  const previousLow = lows[lows.length - 2];

  const bullish =
    lastHigh.price > previousHigh.price &&
    lastLow.price > previousLow.price;

  const bearish =
    lastHigh.price < previousHigh.price &&
    lastLow.price < previousLow.price;

  return {

    bias: bullish
      ? "BULLISH"
      : bearish
        ? "BEARISH"
        : "NEUTRAL",

    lastHigh,

    previousHigh,

    lastLow,

    previousLow

  };

}


// ================================================================
// EMA
// ================================================================

function calculateEMA(candles, period) {

  if (candles.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = candles
    .slice(0, period)
    .reduce((sum, c) => sum + c.close, 0) / period;

  for (let i = period; i < candles.length; i++) {

    ema =
      (candles[i].close - ema) * multiplier +
      ema;

  }

  return ema;

}


// ================================================================
// HIGHER TIMEFRAME BIAS
// ================================================================

function getHTFBias(candles) {

  if (candles.length < 55) {
    return "NEUTRAL";
  }

  const structure = getStructure(candles);

  const ema20 = calculateEMA(candles, 20);

  const ema50 = calculateEMA(candles, 50);

  const lastClose =
    candles[candles.length - 1].close;

  let score = 0;

  if (structure.bias === "BULLISH") score += 2;

  if (structure.bias === "BEARISH") score -= 2;

  if (ema20 && ema50) {

    if (
      ema20 > ema50 &&
      lastClose > ema20
    ) {

      score += 1;

    }

    if (
      ema20 < ema50 &&
      lastClose < ema20
    ) {

      score -= 1;

    }

  }

  if (score >= 2) return "BULLISH";

  if (score <= -2) return "BEARISH";

  return "NEUTRAL";

}


// ================================================================
// CANDLE BODY
// ================================================================

function candleBody(candle) {

  return Math.abs(
    candle.close - candle.open
  );

}


function candleRange(candle) {

  return candle.high - candle.low;

}


function isBullishCandle(candle) {

  return candle.close > candle.open;

}


function isBearishCandle(candle) {

  return candle.close < candle.open;

}


// ================================================================
// AVERAGE BODY
// ================================================================

function averageBody(candles, endIndex, count = 10) {

  const start = Math.max(
    0,
    endIndex - count
  );

  const values = [];

  for (
    let i = start;
    i < endIndex;
    i++
  ) {

    values.push(
      candleBody(candles[i])
    );

  }

  if (!values.length) return 0;

  return values.reduce(
    (a, b) => a + b,
    0
  ) / values.length;

}


// ================================================================
// LIQUIDITY SWEEP
// ================================================================

function findLiquiditySweep(
  candles,
  direction,
  endIndex
) {

  const swings = findSwings(
    candles.slice(
      0,
      endIndex + 1
    ),
    SETTINGS.SWING_LOOKBACK
  );

  const highs = swings.filter(
    s => s.type === "high"
  );

  const lows = swings.filter(
    s => s.type === "low"
  );

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return null;

  }

  const current = candles[endIndex];

  if (direction === "bullish") {

    const target =
      lows[lows.length - 1];

    if (
      current.low < target.price &&
      current.close > target.price
    ) {

      return {

        type: "sell-side liquidity sweep",

        price: target.price,

        index: endIndex

      };

    }

  }

  if (direction === "bearish") {

    const target =
      highs[highs.length - 1];

    if (
      current.high > target.price &&
      current.close < target.price
    ) {

      return {

        type: "buy-side liquidity sweep",

        price: target.price,

        index: endIndex

      };

    }

  }

  return null;

}


// ================================================================
// DISPLACEMENT
// ================================================================

function isDisplacement(
  candles,
  index,
  direction
) {

  if (index < 10) return false;

  const c = candles[index];

  const range = candleRange(c);

  if (range <= 0) return false;

  const body = candleBody(c);

  const bodyRatio =
    body / range;

  const avgBody =
    averageBody(
      candles,
      index,
      10
    );

  if (
    bodyRatio <
    SETTINGS.MIN_DISPLACEMENT_BODY_RATIO
  ) {

    return false;

  }

  if (
    avgBody > 0 &&
    body <
    avgBody *
    SETTINGS.MIN_DISPLACEMENT_MULTIPLIER
  ) {

    return false;

  }

  if (
    direction === "bullish" &&
    !isBullishCandle(c)
  ) {

    return false;

  }

  if (
    direction === "bearish" &&
    !isBearishCandle(c)
  ) {

    return false;

  }

  return true;

}


// ================================================================
// BOS AFTER LIQUIDITY SWEEP
// ================================================================

function findStructureBreak(
  candles,
  direction,
  fromIndex
) {

  const swings = findSwings(
    candles.slice(
      0,
      fromIndex + 1
    ),
    SETTINGS.SWING_LOOKBACK
  );

  const highs = swings.filter(
    s => s.type === "high"
  );

  const lows = swings.filter(
    s => s.type === "low"
  );

  if (
    highs.length < 2 ||
    lows.length < 2
  ) {

    return null;

  }

  if (direction === "bullish") {

    const target =
      highs[highs.length - 1];

    for (
      let i = fromIndex + 1;
      i < candles.length;
      i++
    ) {

      if (
        candles[i].close >
        target.price
      ) {

        return {

          index: i,

          price: target.price,

          type: "BOS"

        };

      }

    }

  }

  if (direction === "bearish") {

    const target =
      lows[lows.length - 1];

    for (
      let i = fromIndex + 1;
      i < candles.length;
      i++
    ) {

      if (
        candles[i].close <
        target.price
      ) {

        return {

          index: i,

          price: target.price,

          type: "BOS"

        };

      }

    }

  }

  return null;

}


// ================================================================
// FVG
// ================================================================

function findFVGAt(
  candles,
  index,
  direction
) {

  if (index < 2) return null;

  const c1 = candles[index - 2];

  const c2 = candles[index - 1];

  const c3 = candles[index];

  if (direction === "bullish") {

    if (
      c1.high < c3.low
    ) {

      return {

        top: c3.low,

        bottom: c1.high,

        index,

        midpoint:
          (c3.low + c1.high) / 2

      };

    }

  }

  if (direction === "bearish") {

    if (
      c1.low > c3.high
    ) {

      return {

        top: c1.low,

        bottom: c3.high,

        index,

        midpoint:
          (c1.low + c3.high) / 2

      };

    }

  }

  return null;

}


// ================================================================
// SUPPLY / DEMAND ZONE
// ================================================================

function findSupplyDemandZone(
  candles,
  displacementIndex,
  direction
) {

  const start =
    Math.max(
      0,
      displacementIndex - 6
    );

  for (
    let i = displacementIndex - 1;
    i >= start;
    i--
  ) {

    const c = candles[i];

    if (
      direction === "bullish" &&
      isBearishCandle(c)
    ) {

      return {

        type: "DEMAND",

        top: c.high,

        bottom: c.low,

        index: i

      };

    }

    if (
      direction === "bearish" &&
      isBullishCandle(c)
    ) {

      return {

        type: "SUPPLY",

        top: c.high,

        bottom: c.low,

        index: i

      };

    }

  }

  return null;

}


// ================================================================
// ORDER BLOCK
// ================================================================

function findOrderBlock(
  candles,
  displacementIndex,
  direction
) {

  const zone =
    findSupplyDemandZone(
      candles,
      displacementIndex,
      direction
    );

  if (!zone) return null;

  return {

    top: zone.top,

    bottom: zone.bottom,

    index: zone.index,

    type:
      direction === "bullish"
        ? "BULLISH OB"
        : "BEARISH OB"

  };

}


// ================================================================
// ZONE OVERLAP
// ================================================================

function zonesOverlap(a, b) {

  if (!a || !b) return false;

  return (
    Math.max(
      a.bottom,
      b.bottom
    ) <=
    Math.min(
      a.top,
      b.top
    )
  );

}


// ================================================================
// BUILD SETUP
// ================================================================

function buildSetup(
  pair,
  candles,
  htfBias
) {

  if (candles.length < 40) {
    return null;
  }

  if (
    htfBias !== "BULLISH" &&
    htfBias !== "BEARISH"
  ) {

    return null;

  }

  const direction =
    htfBias === "BULLISH"
      ? "bullish"
      : "bearish";

  const latestIndex =
    candles.length - 1;

  /*
   * Look through recent candles for:
   *
   * liquidity sweep
   * +
   * displacement
   * +
   * BOS
   */

  const searchStart =
    Math.max(
      10,
      latestIndex - 12
    );

  for (
    let sweepIndex = latestIndex;
    sweepIndex >= searchStart;
    sweepIndex--
  ) {

    const sweep =
      findLiquiditySweep(
        candles,
        direction,
        sweepIndex
      );

    if (!sweep) continue;

    for (
      let displacementIndex =
        sweepIndex + 1;
      displacementIndex <=
        Math.min(
          latestIndex,
          sweepIndex + 4
        );
      displacementIndex++
    ) {

      if (
        !isDisplacement(
          candles,
          displacementIndex,
          direction
        )
      ) {

        continue;

      }

      const structureBreak =
        findStructureBreak(
          candles,
          direction,
          displacementIndex
        );

      if (!structureBreak) {
        continue;
      }

      if (
        structureBreak.index >
        latestIndex
      ) {

        continue;

      }

      const fvg =
        findFVGAt(
          candles,
          displacementIndex,
          direction
        );

      const zone =
        findSupplyDemandZone(
          candles,
          displacementIndex,
          direction
        );

      const ob =
        findOrderBlock(
          candles,
          displacementIndex,
          direction
        );

      if (!zone) continue;

      /*
       * Require either FVG or OB.
       * If both exist, preferably they overlap.
       */

      if (!fvg && !ob) {
        continue;
      }

      if (
        fvg &&
        ob &&
        !zonesOverlap(fvg, ob)
      ) {

        /*
         * Don't force the trade if the
         * FVG and OB are unrelated.
         */

        continue;

      }

      return {

        direction,

        label: structureBreak.type,

        sweep,

        displacementIndex,

        structureBreak,

        fvg,

        supplyDemand: zone,

        orderBlock: ob,

        createdAt: Date.now(),

        retested: false,

        confirmed: false

      };

    }

  }

  return null;

}


// ================================================================
// CHECK RETEST
// ================================================================

function getEntryZone(setup) {

  const zones = [];

  if (setup.supplyDemand) {
    zones.push(setup.supplyDemand);
  }

  if (setup.fvg) {
    zones.push(setup.fvg);
  }

  if (setup.orderBlock) {
    zones.push(setup.orderBlock);
  }

  if (!zones.length) {
    return null;
  }

  let top =
    Math.min(
      ...zones.map(z => z.top)
    );

  let bottom =
    Math.max(
      ...zones.map(z => z.bottom)
    );

  /*
   * If zones don't mathematically overlap,
   * use the supply/demand zone.
   */

  if (bottom > top) {

    const primary =
      setup.supplyDemand ||
      setup.orderBlock ||
      setup.fvg;

    top = primary.top;

    bottom = primary.bottom;

  }

  return {

    top,

    bottom,

    midpoint:
      (top + bottom) / 2

  };

}


// ================================================================
// CONFIRMATION CANDLE
// ================================================================

function confirmationCandle(
  candles,
  setup
) {

  const zone =
    getEntryZone(setup);

  if (!zone) return null;

  const c =
    candles[candles.length - 1];

  if (!c) return null;

  const touchesZone =
    c.low <= zone.top &&
    c.high >= zone.bottom;

  if (!touchesZone) {
    return null;
  }

  const range =
    candleRange(c);

  if (range <= 0) {
    return null;
  }

  const body =
    candleBody(c);

  const bodyRatio =
    body / range;

  if (bodyRatio < 0.45) {
    return null;
  }

  if (
    setup.direction === "bullish"
  ) {

    if (!isBullishCandle(c)) {
      return null;
    }

    /*
     * Bullish rejection:
     * candle closes in upper half.
     */

    const closePosition =
      (c.close - c.low) / range;

    if (closePosition < 0.60) {
      return null;
    }

    return c;

  }

  if (
    setup.direction === "bearish"
  ) {

    if (!isBearishCandle(c)) {
      return null;
    }

    /*
     * Bearish rejection:
     * candle closes in lower half.
     */

    const closePosition =
      (c.high - c.close) / range;

    if (closePosition < 0.60) {
      return null;
    }

    return c;

  }

  return null;

}


// ================================================================
// TARGET / STOP CALCULATION
// ================================================================

function calculateTradeLevels(
  pair,
  setup,
  entryPrice
) {

  const pip =
    pipSize(pair);

  const buffer =
    SETTINGS.SL_BUFFER_PIPS * pip;

  const zone =
    getEntryZone(setup);

  if (!zone) return null;

  let stopLoss;

  if (
    setup.direction === "bullish"
  ) {

    const swingLow =
      setup.sweep?.price ||
      zone.bottom;

    stopLoss =
      Math.min(
        zone.bottom,
        swingLow
      ) - buffer;

  } else {

    const swingHigh =
      setup.sweep?.price ||
      zone.top;

    stopLoss =
      Math.max(
        zone.top,
        swingHigh
      ) + buffer;

  }

  const risk =
    Math.abs(
      entryPrice - stopLoss
    );

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {

    return null;

  }

  /*
   * Target is at least 1.8R.
   */

  const minimumReward =
    risk * SETTINGS.MIN_RR;

  /*
   * Convert to pip distance.
   */

  const minimumPips =
    minimumReward / pip;

  let targetPips =
    Math.max(
      SETTINGS.MIN_TARGET_PIPS,
      minimumPips
    );

  targetPips =
    Math.min(
      SETTINGS.MAX_TARGET_PIPS,
      targetPips
    );

  /*
   * If 1.8R requires more than our
   * maximum target, don't take it.
   */

  if (
    targetPips <
    minimumPips
  ) {

    return null;

  }

  let takeProfit;

  if (
    setup.direction === "bullish"
  ) {

    takeProfit =
      entryPrice +
      targetPips * pip;

  } else {

    takeProfit =
      entryPrice -
      targetPips * pip;

  }

  return {

    stopLoss,

    takeProfit,

    risk,

    targetPips,

    rr:
      Math.abs(
        takeProfit - entryPrice
      ) / risk

  };

}


// ================================================================
// OPEN SIGNAL CHECK
// ================================================================

function hasOpenSignal(pair) {

  return signalHistory.some(
    s =>
      s.pair === pair &&
      s.status === "open"
  );

}


// ================================================================
// FIRE SIGNAL
// ================================================================

function fireSignal(
  pair,
  setup,
  entryPrice
) {

  const state =
    market[pair];

  if (
    Date.now() -
    state.lastSignalTime <
    SETTINGS.SIGNAL_COOLDOWN_MS
  ) {

    console.log(
      `[${pair}] Cooldown active`
    );

    return;

  }

  if (hasOpenSignal(pair)) {
    return;
  }

  const levels =
    calculateTradeLevels(
      pair,
      setup,
      entryPrice
    );

  if (!levels) {

    console.log(
      `[${pair}] Trade rejected: bad R:R or SL`
    );

    return;

  }

  const direction =
    setup.direction === "bullish"
      ? "BUY"
      : "SELL";

  const emoji =
    direction === "BUY"
      ? "🟢"
      : "🔴";

  const decimals =
    decimalsFor(pair);

  const message =
`🚨 ${pair} FOREX SIGNAL V2

${emoji} ${direction} @ ${entryPrice.toFixed(decimals)}

🛡️ Stop Loss:
${levels.stopLoss.toFixed(decimals)}

🎯 Take Profit:
${levels.takeProfit.toFixed(decimals)}

📏 Target:
~${levels.targetPips.toFixed(0)} pips

📊 CONFIRMATION
• 1H ${state.bias} bias
• Liquidity sweep
• Displacement
• ${setup.label}
• ${setup.supplyDemand?.type || "Supply/Demand"}
• FVG
• Order Block
• Retest + confirmation candle

📐 Risk/Reward:
1:${levels.rr.toFixed(2)}

⚠️ Manage your own risk.
This is not financial advice.`;

  const signal = {

    id:
      `${Date.now()}-${Math.floor(
        Math.random() * 10000
      )}`,

    pair,

    time: Date.now(),

    label: setup.label,

    direction,

    entryPrice,

    stopLoss: levels.stopLoss,

    takeProfit: levels.takeProfit,

    targetPips: levels.targetPips,

    rr: levels.rr,

    status: "open",

    closedAt: null,

    closePrice: null,

    setupDetails: {

      bias: state.bias,

      sweep: setup.sweep?.type,

      zone: setup.supplyDemand?.type,

      fvg: !!setup.fvg,

      orderBlock: !!setup.orderBlock

    }

  };

  signalHistory.unshift(signal);

  if (
    signalHistory.length >
    MAX_SIGNAL_HISTORY
  ) {

    signalHistory.pop();

  }

  state.lastSignalTime =
    Date.now();

  console.log(
    `[SIGNAL FIRED] ${pair} ${direction} @ ${entryPrice} RR=${levels.rr.toFixed(2)}`
  );

  for (
    const chatId of subscribers.keys()
  ) {

    bot.sendMessage(
      chatId,
      message
    ).catch(err => {

      console.error(
        `Signal send failed ${chatId}:`,
        err.message
      );

    });

  }

}


// ================================================================
// ANALYZE PAIR
// ================================================================

function analyzePair(pair) {

  const state =
    market[pair];

  const htf =
    state.htfCandles;

  const candles =
    state.entryCandles;

  if (
    htf.length < 55 ||
    candles.length < 50
  ) {

    state.lastAnalysis =
      "Building market history";

    return;

  }

  const latest =
    candles[candles.length - 1];

  state.lastPrice =
    latest.close;

  /*
   * Avoid repeatedly processing the
   * exact same candle.
   */

  if (
    latest.time ===
    state.lastProcessedCandleTime
  ) {

    return;

  }

  state.lastProcessedCandleTime =
    latest.time;

  const htfBias =
    getHTFBias(htf);

  state.bias =
    htfBias;

  const entryStructure =
    getStructure(candles);

  state.structure =
    entryStructure.bias;

  /*
   * Existing setup
   */

  if (state.pendingSetup) {

    const setup =
      state.pendingSetup;

    if (
      Date.now() -
      setup.createdAt >
      SETTINGS.SETUP_EXPIRY_MS
    ) {

      console.log(
        `[${pair}] Setup expired`
      );

      state.pendingSetup = null;

      state.lastAnalysis =
        "Setup expired";

      return;

    }

    /*
     * If HTF bias changed against setup,
     * cancel it.
     */

    if (
      (
        setup.direction === "bullish" &&
        htfBias !== "BULLISH"
      ) ||
      (
        setup.direction === "bearish" &&
        htfBias !== "BEARISH"
      )
    ) {

      console.log(
        `[${pair}] Setup cancelled: HTF bias changed`
      );

      state.pendingSetup = null;

      state.lastAnalysis =
        "Setup cancelled - HTF bias changed";

      return;

    }

    const confirm =
      confirmationCandle(
        candles,
        setup
      );

    if (confirm) {

      fireSignal(
        pair,
        setup,
        confirm.close
      );

      state.pendingSetup = null;

      state.lastAnalysis =
        "Signal fired";

      return;

    }

    state.lastAnalysis =
      `Waiting for ${setup.supplyDemand?.type || "zone"} retest`;

    return;

  }

  /*
   * Don't create a new setup if a
   * signal is already open.
   */

  if (hasOpenSignal(pair)) {

    state.lastAnalysis =
      "Signal open - tracking result";

    return;

  }

  /*
   * Only look for trades when HTF bias
   * is clear.
   */

  if (
    htfBias !== "BULLISH" &&
    htfBias !== "BEARISH"
  ) {

    state.lastAnalysis =
      "NO TRADE - HTF bias neutral";

    return;

  }

  const setup =
    buildSetup(
      pair,
      candles,
      htfBias
    );

  if (!setup) {

    state.lastAnalysis =
      `NO TRADE - waiting for liquidity + displacement + structure`;

    return;

  }

  state.pendingSetup =
    setup;

  state.lastAnalysis =
    `Setup found - waiting for ${setup.supplyDemand.type} retest`;

  console.log(
    `[${pair}] ${setup.direction.toUpperCase()} setup found`
  );

}


// ================================================================
// RESULT TRACKER
// ================================================================

function checkOpenSignals() {

  const openSignals =
    signalHistory.filter(
      s => s.status === "open"
    );

  for (
    const signal of openSignals
  ) {

    const state =
      market[signal.pair];

    if (
      !state ||
      state.entryCandles.length === 0
    ) {

      continue;

    }

    const candle =
      state.entryCandles[
        state.entryCandles.length - 1
      ];

    let hitTP = false;

    let hitSL = false;

    /*
     * IMPORTANT:
     * We now use HIGH/LOW instead
     * of candle CLOSE.
     */

    if (
      signal.direction === "BUY"
    ) {

      hitTP =
        candle.high >=
        signal.takeProfit;

      hitSL =
        candle.low <=
        signal.stopLoss;

    } else {

      hitTP =
        candle.low <=
        signal.takeProfit;

      hitSL =
        candle.high >=
        signal.stopLoss;

    }

    /*
     * If both were touched inside
     * one candle, use conservative
     * assumption: SL first.
     */

    if (hitSL) {

      signal.status = "loss";

      signal.closePrice =
        signal.stopLoss;

    } else if (hitTP) {

      signal.status = "win";

      signal.closePrice =
        signal.takeProfit;

    } else {

      continue;

    }

    signal.closedAt =
      Date.now();

    market[
      signal.pair
    ].lastSignalTime =
      Date.now();

    const decimals =
      decimalsFor(signal.pair);

    const isWin =
      signal.status === "win";

    const resultEmoji =
      isWin
        ? "🏆"
        : "🔴";

    const resultText =
      isWin
        ? "TAKE PROFIT HIT"
        : "STOP LOSS HIT";

    const closeMessage =
`${resultEmoji} ${signal.pair} SIGNAL RESULT

${resultText}

${signal.direction} @ ${signal.entryPrice.toFixed(decimals)}

Closed @ ${signal.closePrice.toFixed(decimals)}

${isWin
  ? "🎯 Target reached."
  : "🛡️ Stop loss reached."}

📊 Result:
${isWin ? "WIN ✅" : "LOSS ❌"}`;

    console.log(
      `[RESULT] ${signal.pair} ${signal.direction} -> ${signal.status.toUpperCase()}`
    );

    for (
      const chatId of subscribers.keys()
    ) {

      bot.sendMessage(
        chatId,
        closeMessage
      ).catch(err => {

        console.error(
          `Result send failed ${chatId}:`,
          err.message
        );

      });

    }

  }

}


// ================================================================
// MAIN MARKET LOOP
// ================================================================

async function runCycle() {

  try {

    console.log(
      "=========================================="
    );

    console.log(
      "🔄 Refreshing forex market data..."
    );

    await fetchAllMarketData();

    /*
     * Check existing trades BEFORE
     * hunting for new ones.
     */

    checkOpenSignals();

    PAIRS.forEach(pair => {

      analyzePair(pair);

    });

    console.log(
      `[CYCLE] ${new Date().toLocaleString()}`
    );

    PAIRS.forEach(pair => {

      const state =
        market[pair];

      console.log(
        `${pair} | Price=${state.lastPrice || "-"} | Bias=${state.bias} | Structure=${state.structure} | ${state.lastAnalysis}`
      );

    });

  } catch (error) {

    console.error(
      "Market cycle error:",
      error.response?.data ||
      error.message
    );

  }

}


/*
 * 15-minute strategy.
 *
 * The strategy now uses:
 *
 * 1H = direction
 * 15M = entry structure
 *
 * Refresh every 15 minutes.
 */

const REFRESH_INTERVAL_MS =
  15 * 60 * 1000;

setInterval(
  runCycle,
  REFRESH_INTERVAL_MS
);

runCycle();


// ================================================================
// TELEGRAM /START
// ================================================================

bot.onText(
  /\/start/,
  msg => {

    autoSubscribe(msg);

    bot.sendMessage(
      msg.chat.id,

`💱 FOREX SIGNALS BOT V2

Welcome 👋

Markets:

• EUR/USD
• GBP/USD
• USD/JPY
• AUD/USD
• USD/CAD
• EUR/GBP

🧠 NEW SIGNAL ENGINE

1️⃣ 1H market bias
2️⃣ 15M structure
3️⃣ Liquidity sweep
4️⃣ Displacement
5️⃣ BOS / CHoCH
6️⃣ Supply / Demand
7️⃣ FVG
8️⃣ Order Block
9️⃣ Retest
🔟 Confirmation candle

🚫 Weak setups are rejected.

🎯 Dynamic TP
📐 Minimum R:R
🛡️ Structure-based SL

🔔 Automatic alerts are ON.`,

      mainMenu

    );

  }
);


// ================================================================
// TELEGRAM MENU
// ================================================================

bot.on(
  "message",
  async msg => {

    if (!msg.text) return;

    autoSubscribe(msg);

    if (
      msg.text ===
      "📊 Market Status"
    ) {

      const lines =
        PAIRS.map(pair => {

          const state =
            market[pair];

          if (
            state.entryCandles.length < 50
          ) {

            return `${pair}: ⏳ Building history`;

          }

          if (
            hasOpenSignal(pair)
          ) {

            return `${pair}: 📈 Signal active | ${state.bias}`;

          }

          if (
            state.pendingSetup
          ) {

            return `${pair}: 👀 ${state.pendingSetup.direction.toUpperCase()} setup | ${state.pendingSetup.supplyDemand?.type || "ZONE"}`;

          }

          return `${pair}: 🔎 ${state.bias} | ${state.lastAnalysis}`;

        });

      bot.sendMessage(

        msg.chat.id,

`📊 FOREX MARKET STATUS

${lines.join("\n")}`

      );

    }


    if (
      msg.text ===
      "📖 How It Works"
    ) {

      bot.sendMessage(

        msg.chat.id,

`📖 FOREX SIGNAL ENGINE V2

The bot does NOT enter simply because it sees BOS/CHoCH.

It checks:

1️⃣ 1H direction
2️⃣ 15M structure
3️⃣ Liquidity sweep
4️⃣ Strong displacement
5️⃣ BOS / CHoCH
6️⃣ Supply/Demand location
7️⃣ FVG
8️⃣ Order Block
9️⃣ Zone retest
🔟 Confirmation candle
1️⃣1️⃣ Risk/Reward

If the conditions don't align:

🚫 NO TRADE

Results are checked using candle HIGH/LOW so TP/SL touches are detected more accurately.

⏱️ Market refresh:
Every 15 minutes.`

      );

    }


    if (
      msg.text ===
      "⚙️ Settings"
    ) {

      const counts =
        PAIRS.map(
          p =>
            `${p}: ${market[p].entryCandles.length} candles`
        ).join("\n");

      bot.sendMessage(

        msg.chat.id,

`⚙️ FOREX ENGINE V2

📊 Markets
${PAIRS.join(", ")}

🧠 HTF
1H

📈 Entry
15M

🎯 Minimum R:R
1:${SETTINGS.MIN_RR}

🎯 Target range
${SETTINGS.MIN_TARGET_PIPS}-${SETTINGS.MAX_TARGET_PIPS} pips

🔔 Alerts
ON

⏱️ Refresh
Every 15 minutes

${counts}`

      );

    }

  }
);


// ================================================================
// ADMIN HELPERS
// ================================================================

function escapeHtml(str) {

  if (
    str === null ||
    str === undefined
  ) {

    return "";

  }

  return String(str)

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    );

}


function formatUptime(ms) {

  const totalMinutes =
    Math.floor(ms / 60000);

  return `${Math.floor(
    totalMinutes / 60
  )}h ${totalMinutes % 60}m`;

}


// ================================================================
// ADMIN PANEL
// ================================================================

app.get(
  "/admin",
  requireAdminAuth,
  (req, res) => {

    const pairRows =
      PAIRS.map(pair => {

        const state =
          market[pair];

        const price =
          state.lastPrice;

        const decimals =
          decimalsFor(pair);

        let status;

        if (
          hasOpenSignal(pair)
        ) {

          status =
            "📈 Signal open";

        } else if (
          state.pendingSetup
        ) {

          status =
            `👀 ${escapeHtml(
              state.pendingSetup.direction
            )} ${
              state.pendingSetup.supplyDemand?.type ||
              "ZONE"
            }`;

        } else {

          status =
            `🔎 ${escapeHtml(
              state.lastAnalysis
            )}`;

        }

        return `
<tr>

<td>${pair}</td>

<td>
${
  price !== null
    ? price.toFixed(decimals)
    : "—"
}
</td>

<td>
${state.bias}
</td>

<td>
${state.structure}
</td>

<td>
${status}
</td>

</tr>`;

      }).join("");


    const subscriberRows =
      [...subscribers.entries()]
        .map(
          ([chatId, info]) => `

<tr>

<td>
${escapeHtml(info.firstName)}
${
  info.username
    ? " (@" +
      escapeHtml(info.username) +
      ")"
    : ""
}
</td>

<td>${chatId}</td>

<td>
${new Date(
  info.joinedAt
).toLocaleString()}
</td>

<td>

<form
method="POST"
action="/admin/remove"
style="margin:0;"
>

<input
type="hidden"
name="chatId"
value="${chatId}"
>

<button
type="submit"
class="danger"
>
Remove
</button>

</form>

</td>

</tr>

`
        )
        .join("")
      ||
      `
<tr>
<td colspan="4">
No subscribers yet.
</td>
</tr>
`;


    const statusBadge = {

      open: "⏳ Open",

      win: "🏆 Win",

      loss: "❌ Loss"

    };


    const signalRows =
      signalHistory
        .slice(0, 50)
        .map(signal => {

          const decimals =
            decimalsFor(
              signal.pair
            );

          return `

<tr>

<td>
${new Date(
  signal.time
).toLocaleString()}
</td>

<td>
${signal.pair}
</td>

<td>
${signal.label}
</td>

<td>
${signal.direction}
</td>

<td>
${signal.entryPrice.toFixed(decimals)}
</td>

<td>
${signal.stopLoss.toFixed(decimals)}
</td>

<td>
${signal.takeProfit.toFixed(decimals)}
</td>

<td>
${statusBadge[
  signal.status
] || signal.status}
</td>

</tr>

`;

        })
        .join("")
      ||
      `
<tr>
<td colspan="8">
No signals fired yet.
</td>
</tr>
`;


    const wins =
      signalHistory.filter(
        s => s.status === "win"
      ).length;

    const losses =
      signalHistory.filter(
        s => s.status === "loss"
      ).length;

    const openCount =
      signalHistory.filter(
        s => s.status === "open"
      ).length;

    const decided =
      wins + losses;

    const winRate =
      decided > 0
        ? (
            wins /
            decided *
            100
          ).toFixed(1)
        : "—";


    res.send(`

<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width, initial-scale=1"
>

<title>
Forex Signals V2 - Admin
</title>

<style>

body {

font-family:
-apple-system,
BlinkMacSystemFont,
Arial,
sans-serif;

background:
#0f1115;

color:
#eee;

margin:
0;

padding:
16px;

}

h1 {

font-size:
1.3rem;

}

h2 {

font-size:
1.05rem;

margin-top:
28px;

color:
#f5c542;

}

.stats {

display:
flex;

flex-wrap:
wrap;

gap:
10px;

margin:
12px 0;

}

.card {

background:
#1b1f27;

border-radius:
10px;

padding:
12px 16px;

flex:
1 1 140px;

}

.card .label {

font-size:
0.75rem;

color:
#999;

}

.card .value {

font-size:
1.3rem;

font-weight:
bold;

margin-top:
4px;

}

table {

width:
100%;

border-collapse:
collapse;

margin-top:
8px;

font-size:
0.82rem;

}

th,
td {

text-align:
left;

padding:
8px 6px;

border-bottom:
1px solid #2a2f3a;

white-space:
nowrap;

}

th {

color:
#aaa;

font-weight:
normal;

}

button {

background:
#2b6fe0;

color:
white;

border:
none;

padding:
8px 14px;

border-radius:
6px;

font-size:
0.85rem;

}

button.danger {

background:
#c0392b;

}

textarea {

width:
100%;

box-sizing:
border-box;

background:
#1b1f27;

color:
#eee;

border:
1px solid #333;

border-radius:
6px;

padding:
8px;

font-size:
0.9rem;

}

.scroll {

overflow-x:
auto;

}

.note {

background:
#171b22;

padding:
12px;

border-radius:
8px;

margin:
10px 0;

line-height:
1.5;

}

</style>

</head>

<body>


<h1>
💱 Forex Signals Engine V2
</h1>


<div class="note">

<b>Strategy:</b>

1H Bias →
15M Structure →
Liquidity Sweep →
Displacement →
BOS/CHoCH →
Supply/Demand →
FVG/OB →
Retest →
Confirmation

</div>


<div class="stats">


<div class="card">

<div class="label">
Bot uptime
</div>

<div class="value">
${formatUptime(
  Date.now() -
  botStartedAt
)}
</div>

</div>


<div class="card">

<div class="label">
Subscribers
</div>

<div class="value">
${subscribers.size}
</div>

</div>


<div class="card">

<div class="label">
Signals
</div>

<div class="value">
${signalHistory.length}
</div>

</div>


</div>


<div class="stats">


<div class="card">

<div class="label">
Win rate
</div>

<div class="value">
${winRate}
${
  decided > 0
    ? "%"
    : ""
}
</div>

</div>


<div class="card">

<div class="label">
Wins
</div>

<div class="value">
${wins}
</div>

</div>


<div class="card">

<div class="label">
Losses
</div>

<div class="value">
${losses}
</div>

</div>


<div class="card">

<div class="label">
Open
</div>

<div class="value">
${openCount}
</div>

</div>


</div>


<h2>
Markets
</h2>


<div class="scroll">

<table>

<tr>

<th>
Pair
</th>

<th>
Price
</th>

<th>
1H Bias
</th>

<th>
15M Structure
</th>

<th>
Status
</th>

</tr>

${pairRows}

</table>

</div>


<h2>
Broadcast
</h2>


<form
method="POST"
action="/admin/broadcast"
>

<textarea
name="message"
rows="3"
placeholder="Type a message..."
></textarea>

<br>
<br>

<button
type="submit"
>
Send Broadcast
</button>

</form>


<h2>
Subscribers (${subscribers.size})
</h2>


<div class="scroll">

<table>

<tr>

<th>
Name
</th>

<th>
Chat ID
</th>

<th>
Joined
</th>

<th>
Action
</th>

</tr>

${subscriberRows}

</table>

</div>


<h2>
Recent Signals
</h2>


<div class="scroll">

<table>

<tr>

<th>
Time
</th>

<th>
Pair
</th>

<th>
Type
</th>

<th>
Direction
</th>

<th>
Entry
</th>

<th>
SL
</th>

<th>
TP
</th>

<th>
Result
</th>

</tr>

${signalRows}

</table>

</div>


</body>

</html>

`);

  }
);


// ================================================================
// ADMIN REMOVE USER
// ================================================================

app.post(
  "/admin/remove",
  requireAdminAuth,
  (req, res) => {

    subscribers.delete(
      Number(req.body.chatId)
    );

    res.redirect("/admin");

  }
);


// ================================================================
// ADMIN BROADCAST
// ================================================================

app.post(
  "/admin/broadcast",
  requireAdminAuth,
  async (req, res) => {

    const message =
      (req.body.message || "")
        .trim();

    if (message) {

      for (
        const chatId of subscribers.keys()
      ) {

        bot.sendMessage(
          chatId,
          `📢 ${message}`
        ).catch(err => {

          console.error(
            `Broadcast failed ${chatId}:`,
            err.message
          );

        });

      }

    }

    res.redirect("/admin");

  }
);


// ================================================================
// CLEAN SHUTDOWN
// ================================================================

process.on(
  "SIGTERM",
  async () => {

    try {

      await bot.stopPolling();

    } catch (err) {

      console.error(
        "Error stopping polling:",
        err.message
      );

    }

    process.exit(0);

  }
);


process.on(
  "SIGINT",
  async () => {

    try {

      await bot.stopPolling();

    } catch (err) {

      console.error(
        "Error stopping polling:",
        err.message
      );

    }

    process.exit(0);

  }
);


// ================================================================
// START SERVER
// ================================================================

app.listen(
  PORT,
  () => {

    console.log(
      `💱 FOREX SIGNALS BOT V2 running on port ${PORT}`
    );

    console.log(
      `📊 Markets: ${PAIRS.join(", ")}`
    );

    console.log(
      "🧠 Strategy: 1H Bias + 15M Structure + Liquidity + Supply/Demand + FVG + OB"
    );

  }
);
