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

const bot = new TelegramBot(token, { polling: true });
app.use(express.urlencoded({ extended: true }));


// ===============================
// ADMIN PANEL LOGIN
// ===============================

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme123";

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required.");
  }
  const decoded = Buffer.from(authHeader.split(" ")[1], "base64").toString();
  const [user, pass] = decoded.split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  res.set("WWW-Authenticate", 'Basic realm="Admin Panel"');
  return res.status(401).send("Invalid credentials.");
}


// ===============================
// MARKETS THIS BOT WATCHES
// ===============================

const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD", "EUR/GBP"];

function pipSize(pair) {
  return pair.includes("JPY") ? 0.01 : 0.0001;
}

// Per-pair state - each pair is tracked completely independently.
const market = {};
PAIRS.forEach(pair => {
  market[pair] = {
    candles: [],       // { open, high, low, close, time } oldest -> newest
    pendingSetup: null,
    lastSignalTime: 0
  };
});

const subscribers = new Map(); // chatId -> { username, firstName, joinedAt }
const signalHistory = [];      // most recent first, each tagged with its pair
const MAX_SIGNAL_HISTORY = 150;
const botStartedAt = Date.now();

const SIGNAL_COOLDOWN_MS = 30 * 60 * 1000; // rest period per-pair after a signal closes
const TP_PIPS_MIN = 20;
const TP_PIPS_MAX = 30;


// ===============================
// BOT MENU
// ===============================

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


// ===============================
// WEB SERVER
// ===============================

app.get("/", (req, res) => {
  res.send("💱 FOREX SIGNALS BOT is running.");
});


// ================================================================
// FETCH CANDLES FROM TWELVE DATA (batched, all 6 pairs in 1 call)
// ================================================================

async function fetchAllCandles() {
  const symbolParam = PAIRS.join(",");

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbolParam)}&interval=5min&outputsize=50&apikey=${TWELVE_DATA_API_KEY}`;

  const response = await axios.get(url, { timeout: 15000 });
  const data = response.data;

  // Twelve Data returns a flat object (one symbol) or keyed-by-symbol
  // object (multiple symbols). Normalize both shapes.
  const perSymbol = PAIRS.length === 1 ? { [PAIRS[0]]: data } : data;

  for (const pair of PAIRS) {
    const entry = perSymbol[pair];

    if (!entry || entry.status === "error" || !Array.isArray(entry.values)) {
      console.error(`[${pair}] No valid data returned`, entry && entry.message);
      continue;
    }

    // Twelve Data returns newest-first - flip to oldest-first
    const candles = entry.values
      .map(v => ({
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        time: new Date(v.datetime).getTime()
      }))
      .reverse();

    market[pair].candles = candles;
  }
}


// ================================================================
// SWING HIGH / LOW DETECTION (fractals)
// ================================================================

function findSwings(candles, lookback = 2) {
  const swings = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    const isHigh = slice.every(s => s.high <= c.high);
    const isLow = slice.every(s => s.low >= c.low);
    if (isHigh) swings.push({ index: i, price: c.high, type: "high" });
    if (isLow) swings.push({ index: i, price: c.low, type: "low" });
  }
  return swings;
}


// ================================================================
// FAIR VALUE GAP (FVG) DETECTION
// ================================================================

function findFVG(candles, startIndex, direction) {
  for (let i = startIndex; i >= 2 && i >= startIndex - 5; i--) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (direction === "bullish" && c1.high < c3.low) {
      return { top: c3.low, bottom: c1.high, index: i };
    }
    if (direction === "bearish" && c1.low > c3.high) {
      return { top: c1.low, bottom: c3.high, index: i };
    }
  }
  return null;
}


// ================================================================
// ORDER BLOCK DETECTION
// ================================================================

function findOrderBlock(candles, breakIndex, direction) {
  for (let i = breakIndex; i >= 0 && i >= breakIndex - 6; i--) {
    const c = candles[i];
    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;
    if (direction === "bullish" && isBearishCandle) {
      return { top: c.high, bottom: c.low, index: i };
    }
    if (direction === "bearish" && isBullishCandle) {
      return { top: c.high, bottom: c.low, index: i };
    }
  }
  return null;
}


// ================================================================
// SIGNAL ENGINE - runs per pair, once per refresh cycle
// ================================================================

function hasOpenSignal(pair) {
  return signalHistory.some(s => s.pair === pair && s.status === "open");
}

function analyzePair(pair) {
  const state = market[pair];
  const candles = state.candles;

  if (candles.length < 20) return;          // not enough history yet
  if (hasOpenSignal(pair)) return;           // one trade at a time, per pair

  const swings = findSwings(candles, 2);
  if (swings.length < 4) return;

  const swingHighs = swings.filter(s => s.type === "high");
  const swingLows = swings.filter(s => s.type === "low");

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];
  if (!lastHigh || !prevHigh || !lastLow || !prevLow) return;

  const structureBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
  const structureBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

  const latestClose = candles[candles.length - 1].close;
  const latestIndex = candles.length - 1;

  const brokeAboveHigh = latestClose > lastHigh.price;
  const brokeBelowLow = latestClose < lastLow.price;

  if (brokeAboveHigh && !state.pendingSetup) {
    const fvg = findFVG(candles, latestIndex, "bullish");
    if (fvg) {
      const ob = findOrderBlock(candles, fvg.index, "bullish");
      state.pendingSetup = {
        direction: "bullish",
        label: structureBullish ? "BOS" : "CHoCH",
        fvg, orderBlock: ob,
        structureLow: lastLow.price,
        createdAt: Date.now()
      };
      console.log(`[${pair}] Bullish ${state.pendingSetup.label} detected @ ${latestClose}`);
    }
  }

  if (brokeBelowLow && !state.pendingSetup) {
    const fvg = findFVG(candles, latestIndex, "bearish");
    if (fvg) {
      const ob = findOrderBlock(candles, fvg.index, "bearish");
      state.pendingSetup = {
        direction: "bearish",
        label: structureBearish ? "BOS" : "CHoCH",
        fvg, orderBlock: ob,
        structureHigh: lastHigh.price,
        createdAt: Date.now()
      };
      console.log(`[${pair}] Bearish ${state.pendingSetup.label} detected @ ${latestClose}`);
    }
  }

  if (state.pendingSetup) {
    const setup = state.pendingSetup;

    if (Date.now() - setup.createdAt > 3 * 60 * 60 * 1000) {
      state.pendingSetup = null;
      return;
    }

    const zoneTop = setup.orderBlock ? setup.orderBlock.top : setup.fvg.top;
    const zoneBottom = setup.orderBlock ? setup.orderBlock.bottom : setup.fvg.bottom;
    const priceInZone = latestClose <= zoneTop && latestClose >= zoneBottom;

    if (priceInZone) {
      const confirmCandle = candles[candles.length - 1];
      const bullishConfirm = setup.direction === "bullish" && confirmCandle.close > confirmCandle.open;
      const bearishConfirm = setup.direction === "bearish" && confirmCandle.close < confirmCandle.open;

      if (bullishConfirm || bearishConfirm) {
        fireSignal(pair, setup, latestClose);
        state.pendingSetup = null;
      }
    }
  }
}


// ================================================================
// FIRE SIGNAL
// ================================================================

function fireSignal(pair, setup, entryPrice) {
  const state = market[pair];

  if (Date.now() - state.lastSignalTime < SIGNAL_COOLDOWN_MS) {
    console.log(`[${pair}] Signal skipped - cooldown active`);
    return;
  }

  const pip = pipSize(pair);
  const direction = setup.direction === "bullish" ? "BUY" : "SELL";
  const emoji = setup.direction === "bullish" ? "🟢" : "🔴";
  const decimals = pair.includes("JPY") ? 3 : 5;

  const tpDistance = ((TP_PIPS_MIN + TP_PIPS_MAX) / 2) * pip;
  const buffer = 5 * pip;

  let stopLoss, takeProfit;
  if (setup.direction === "bullish") {
    stopLoss = (setup.orderBlock ? setup.orderBlock.bottom : setup.structureLow) - buffer;
    takeProfit = entryPrice + tpDistance;
  } else {
    stopLoss = (setup.orderBlock ? setup.orderBlock.top : setup.structureHigh) + buffer;
    takeProfit = entryPrice - tpDistance;
  }

  const message =
`🚨 ${pair} SIGNAL - ${setup.label}

${emoji} ${direction} @ ${entryPrice.toFixed(decimals)}

🛡️ Stop Loss: ${stopLoss.toFixed(decimals)}
🎯 Take Profit: ${takeProfit.toFixed(decimals)}
📏 Target: ~${TP_PIPS_MIN}-${TP_PIPS_MAX} pips

📊 Confirmed by:
• Market Structure (${setup.label})
• Fair Value Gap
• Order Block retest + confirmation candle

⚠️ Always manage your own risk. This is not financial advice.`;

  console.log(`[SIGNAL FIRED] ${pair} ${direction} @ ${entryPrice}`);

  signalHistory.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    pair, time: Date.now(), label: setup.label, direction,
    entryPrice, stopLoss, takeProfit,
    status: "open", closedAt: null, closePrice: null
  });
  if (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.pop();

  for (const chatId of subscribers.keys()) {
    bot.sendMessage(chatId, message).catch(err => {
      console.error(`Failed to send signal to ${chatId}:`, err.message);
    });
  }
}


// ================================================================
// OUTCOME TRACKER - checks every open signal against latest candle close
// ================================================================

function checkOpenSignals() {
  const openSignals = signalHistory.filter(s => s.status === "open");

  for (const signal of openSignals) {
    const state = market[signal.pair];
    if (!state || state.candles.length === 0) continue;

    const currentPrice = state.candles[state.candles.length - 1].close;
    const decimals = signal.pair.includes("JPY") ? 3 : 5;

    let hitTP = false, hitSL = false;
    if (signal.direction === "BUY") {
      hitTP = currentPrice >= signal.takeProfit;
      hitSL = currentPrice <= signal.stopLoss;
    } else {
      hitTP = currentPrice <= signal.takeProfit;
      hitSL = currentPrice >= signal.stopLoss;
    }

    if (hitSL) signal.status = "loss";
    else if (hitTP) signal.status = "win";
    else continue;

    signal.closedAt = Date.now();
    signal.closePrice = currentPrice;
    market[signal.pair].lastSignalTime = Date.now();

    const resultEmoji = signal.status === "win" ? "✅" : "❌";
    const resultText = signal.status === "win" ? "TAKE PROFIT HIT" : "STOP LOSS HIT";

    const closeMessage =
`${resultEmoji} ${signal.pair} SIGNAL CLOSED - ${resultText}

${signal.direction} @ ${signal.entryPrice.toFixed(decimals)}
Closed @ ${currentPrice.toFixed(decimals)}

${signal.status === "win" ? "🎯 Target reached." : "🛡️ Stop loss protected your downside."}`;

    console.log(`[SIGNAL CLOSED] ${signal.pair} ${signal.direction} -> ${signal.status.toUpperCase()}`);

    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, closeMessage).catch(err => {
        console.error(`Failed to send close update to ${chatId}:`, err.message);
      });
    }
  }
}


// ================================================================
// MAIN LOOP - refresh candles every 15 minutes (Twelve Data quota)
// ================================================================

async function runCycle() {
  try {
    await fetchAllCandles();
    checkOpenSignals();
    PAIRS.forEach(pair => analyzePair(pair));
    console.log(`[CYCLE] Refreshed all pairs @ ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    console.error("Market cycle error:", error.message);
  }
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes - stays within free Twelve Data quota
setInterval(runCycle, REFRESH_INTERVAL_MS);
runCycle();


// ===============================
// TELEGRAM COMMANDS
// ===============================

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`💱 FOREX SIGNALS BOT

Welcome! 👋

Watching 6 major pairs for you:
${PAIRS.map(p => `• ${p}`).join("\n")}

📊 Market structure analysis
🚨 Entry alerts per pair
🎯 20-30 pip targets
🛡️ Risk levels

Choose an option below:`,
    mainMenu
  );
});

bot.on("message", async (msg) => {
  if (!msg.text) return;

  if (msg.text === "📊 Market Status") {
    const lines = PAIRS.map(pair => {
      const state = market[pair];
      if (state.candles.length < 20) {
        return `${pair}: ⏳ building history (${state.candles.length}/20 candles)`;
      }
      if (hasOpenSignal(pair)) {
        return `${pair}: 📈 signal active, tracking result`;
      }
      if (state.pendingSetup) {
        return `${pair}: 👀 watching a ${state.pendingSetup.label} ${state.pendingSetup.direction.toUpperCase()} setup`;
      }
      return `${pair}: 🔎 scanning, no setup yet`;
    });

    bot.sendMessage(msg.chat.id, `📊 MARKET STATUS\n\n${lines.join("\n")}`);
  }

  if (msg.text === "🔔 Auto Signals") {
    subscribers.set(msg.chat.id, {
      username: msg.from.username || null,
      firstName: msg.from.first_name || "Unknown",
      joinedAt: subscribers.has(msg.chat.id) ? subscribers.get(msg.chat.id).joinedAt : Date.now()
    });

    bot.sendMessage(
      msg.chat.id,
`🔔 AUTOMATIC SIGNALS ENABLED

You'll get an alert the moment any of these confirms a full setup:
${PAIRS.map(p => `• ${p}`).join("\n")}

Each pair is tracked independently - only one open trade per pair at a time, and you'll get a result (win/loss) before that pair looks for its next setup.`
    );
  }

  if (msg.text === "🔕 Stop Alerts") {
    subscribers.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, "🔕 Automatic signals stopped. Turn them back on anytime with 🔔 Auto Signals.");
  }

  if (msg.text === "📖 How It Works") {
    bot.sendMessage(
      msg.chat.id,
`📖 HOW IT WORKS

Each pair is analyzed independently every 15 minutes on 5-minute candles:

📈 Market Structure - BOS / CHoCH
🟨 Fair Value Gap
🟦 Order Block
✅ Retest + confirmation candle before entry
🎯 20-30 pip target
🛡️ Stop loss from the order block / structure point

⏳ Refresh happens every 15 minutes (free data plan limit), so signals can lag slightly behind the live price.

🔒 Each pair only runs one trade at a time - it waits for a result before hunting for the next setup on that pair.`
    );
  }

  if (msg.text === "⚙️ Settings") {
    const candleCounts = PAIRS.map(p => `${p}: ${market[p].candles.length} candles`).join("\n");
    bot.sendMessage(
      msg.chat.id,
`⚙️ SETTINGS

📊 Markets
${PAIRS.join(", ")}

🎯 Target
20-30 pips per trade

⏱️ Refresh
Every 15 minutes

${candleCounts}`
    );
  }
});


// ===============================
// ADMIN PANEL
// ===============================

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUptime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

app.get("/admin", requireAdminAuth, (req, res) => {

  const pairRows = PAIRS.map(pair => {
    const state = market[pair];
    const price = state.candles.length > 0 ? state.candles[state.candles.length - 1].close : null;
    const decimals = pair.includes("JPY") ? 3 : 5;
    const status = hasOpenSignal(pair)
      ? "📈 Signal open"
      : state.pendingSetup
        ? `👀 Watching ${escapeHtml(state.pendingSetup.label)}`
        : state.candles.length < 20
          ? `⏳ ${state.candles.length}/20 candles`
          : "🔎 Scanning";
    return `<tr><td>${pair}</td><td>${price ? price.toFixed(decimals) : "—"}</td><td>${state.candles.length}</td><td>${status}</td></tr>`;
  }).join("");

  const subscriberRows = [...subscribers.entries()].map(([chatId, info]) => `
    <tr>
      <td>${escapeHtml(info.firstName)}${info.username ? " (@" + escapeHtml(info.username) + ")" : ""}</td>
      <td>${chatId}</td>
      <td>${new Date(info.joinedAt).toLocaleString()}</td>
      <td><form method="POST" action="/admin/remove" style="margin:0;"><input type="hidden" name="chatId" value="${chatId}"><button type="submit" class="danger">Remove</button></form></td>
    </tr>
  `).join("") || `<tr><td colspan="4">No subscribers yet.</td></tr>`;

  const statusBadge = { open: "⏳ Open", win: "✅ Win", loss: "❌ Loss" };
  const signalRows = signalHistory.slice(0, 30).map(s => {
    const decimals = s.pair.includes("JPY") ? 3 : 5;
    return `<tr><td>${new Date(s.time).toLocaleString()}</td><td>${s.pair}</td><td>${s.label}</td><td>${s.direction}</td><td>${s.entryPrice.toFixed(decimals)}</td><td>${s.stopLoss.toFixed(decimals)}</td><td>${s.takeProfit.toFixed(decimals)}</td><td>${statusBadge[s.status] || s.status}</td></tr>`;
  }).join("") || `<tr><td colspan="8">No signals fired yet.</td></tr>`;

  const wins = signalHistory.filter(s => s.status === "win").length;
  const losses = signalHistory.filter(s => s.status === "loss").length;
  const openCount = signalHistory.filter(s => s.status === "open").length;
  const decided = wins + losses;
  const winRate = decided > 0 ? ((wins / decided) * 100).toFixed(1) : "—";

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Forex Signals - Admin</title>
      <style>
        body { font-family: -apple-system, Arial, sans-serif; background: #0f1115; color: #eee; margin: 0; padding: 16px; }
        h1 { font-size: 1.3rem; }
        h2 { font-size: 1.05rem; margin-top: 28px; color: #f5c542; }
        .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
        .card { background: #1b1f27; border-radius: 10px; padding: 12px 16px; flex: 1 1 140px; }
        .card .label { font-size: 0.75rem; color: #999; }
        .card .value { font-size: 1.3rem; font-weight: bold; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.85rem; }
        th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a2f3a; }
        th { color: #aaa; font-weight: normal; }
        button { background: #2b6fe0; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.85rem; }
        button.danger { background: #c0392b; }
        textarea { width: 100%; box-sizing: border-box; background: #1b1f27; color: #eee; border: 1px solid #333; border-radius: 6px; padding: 8px; font-size: 0.9rem; }
        .scroll { overflow-x: auto; }
      </style>
    </head>
    <body>
      <h1>💱 Forex Signals - Admin</h1>

      <div class="stats">
        <div class="card"><div class="label">Bot uptime</div><div class="value">${formatUptime(Date.now() - botStartedAt)}</div></div>
        <div class="card"><div class="label">Subscribers</div><div class="value">${subscribers.size}</div></div>
        <div class="card"><div class="label">Signals sent</div><div class="value">${signalHistory.length}</div></div>
      </div>

      <div class="stats">
        <div class="card"><div class="label">Win rate</div><div class="value">${winRate}${decided > 0 ? "%" : ""}</div></div>
        <div class="card"><div class="label">Wins</div><div class="value">${wins}</div></div>
        <div class="card"><div class="label">Losses</div><div class="value">${losses}</div></div>
        <div class="card"><div class="label">Open</div><div class="value">${openCount}</div></div>
      </div>

      <h2>Markets</h2>
      <div class="scroll">
        <table>
          <tr><th>Pair</th><th>Price</th><th>Candles</th><th>Status</th></tr>
          ${pairRows}
        </table>
      </div>

      <h2>Send a manual message to all subscribers</h2>
      <form method="POST" action="/admin/broadcast">
        <textarea name="message" rows="3" placeholder="Type a message to send to every subscriber..."></textarea>
        <br><br>
        <button type="submit">Send Broadcast</button>
      </form>

      <h2>Subscribers (${subscribers.size})</h2>
      <div class="scroll">
        <table>
          <tr><th>Name</th><th>Chat ID</th><th>Joined</th><th></th></tr>
          ${subscriberRows}
        </table>
      </div>

      <h2>Recent Signals</h2>
      <div class="scroll">
        <table>
          <tr><th>Time</th><th>Pair</th><th>Type</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Result</th></tr>
          ${signalRows}
        </table>
      </div>

    </body>
    </html>
  `);
});

app.post("/admin/remove", requireAdminAuth, (req, res) => {
  subscribers.delete(Number(req.body.chatId));
  res.redirect("/admin");
});

app.post("/admin/broadcast", requireAdminAuth, async (req, res) => {
  const text = (req.body.message || "").trim();
  if (text) {
    for (const chatId of subscribers.keys()) {
      bot.sendMessage(chatId, `📢 ${text}`).catch(err => {
        console.error(`Broadcast failed for ${chatId}:`, err.message);
      });
    }
  }
  res.redirect("/admin");
});


// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
  console.log(`💱 FOREX SIGNALS BOT running on port ${PORT}`);
});
