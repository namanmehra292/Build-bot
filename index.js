const mineflayer = require("mineflayer");
const multer = require("multer");
const { Builder } = require("./builder.js");
const express = require("express");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const HOST = process.env.MC_HOST || "play.plumsmp.fun";
const PORT = Number(process.env.MC_PORT || 25565);
const USERNAME = process.env.BOT_USERNAME;
const PASSWORD = process.env.BOT_PASSWORD;
const VERSION = process.env.MC_VERSION || false;
const TPA_TARGET = process.env.TPA_TARGET || "";
const MCP_SECRET = process.env.MCP_SECRET;

if (!USERNAME || !PASSWORD || !MCP_SECRET) {
  console.error("Set BOT_USERNAME, BOT_PASSWORD and MCP_SECRET environment variables.");
  process.exit(1);
}

// ---------- bot state ----------
let bot = null;
let builder = null;
let status = "offline";
let wantOnline = true;
let delay = 15000;
let lastAuth = 0;
let reconnectTimer = null;
const events = [];
const chatLog = [];

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  events.push(line);
  if (events.length > 80) events.shift();
}

function start() {
  if (bot) return;
  clearTimeout(reconnectTimer);
  status = "connecting";
  let banned = false;
  let joined = false;

  let localBuilder;
  const b = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: "offline",
    version: VERSION,
  });
  bot = b;

  const watchdog = setTimeout(() => {
    if (!joined) {
      log("not in the world after 90s, reconnecting");
      b.end("watchdog");
    }
  }, 90000);

  // Config-phase resource pack: reply 3 = accepted, 4 = downloaded, 0 = loaded.
  const packReply = (uuid, result) => {
    try {
      b._client.write("resource_pack_receive", { uuid, result });
    } catch (e) {
      log("pack reply failed: " + e.message);
    }
  };
  b._client.on("add_resource_pack", (p) => {
    if (b._client.state !== "configuration") return;
    log(`config-phase pack ${p.url}, replying accepted/loaded`);
    packReply(p.uuid, 3);
    setTimeout(() => packReply(p.uuid, 4), 400);
    setTimeout(() => {
      packReply(p.uuid, 0);
      log("sent pack status: successfully loaded");
    }, 1000);
  });
  b.on("resourcePack", (url) => {
    log(`resource pack offered (${String(url).slice(0, 80)}), accepting`);
    if (b._client.state === "configuration") return;
    b.acceptResourcePack();
  });

  b.on("messagestr", (msg) => {
    chatLog.push({ t: new Date().toISOString(), msg });
    if (chatLog.length > 300) chatLog.shift();
    const m = msg.toLowerCase();
    if (Date.now() - lastAuth < 5000) return;
    if (m.includes("/register")) {
      lastAuth = Date.now();
      b.chat(`/register ${PASSWORD} ${PASSWORD}`);
      log("sent /register");
    } else if (m.includes("/login")) {
      lastAuth = Date.now();
      b.chat(`/login ${PASSWORD}`);
      log("sent /login");
    }
  });

  b.once("spawn", () => {
    if (!localBuilder) {
      localBuilder = new Builder(b, log);
      builder = localBuilder;
    }
  });

  const markOnline = (why) => {
    if (joined) return;
    joined = true;
    clearTimeout(watchdog);
    status = "online";
    delay = 15000;
    log(`in the world (${why})`);
    if (TPA_TARGET) {
      setTimeout(() => {
        b.chat(`/tpa ${TPA_TARGET}`);
        log(`sent /tpa ${TPA_TARGET}`);
      }, 4000);
    }
  };
  b.once("spawn", () => markOnline("spawn"));
  b.once("respawn", () => markOnline("respawn"));

  b.on("kicked", (reason) => {
    const text = typeof reason === "string" ? reason : JSON.stringify(reason);
    log("kicked: " + text);
    if (/ban/i.test(text)) banned = true;
  });
  b.on("error", (err) => log("error: " + err.message));

  b.on("end", (reason) => {
    clearTimeout(watchdog);
    if (bot === b) bot = null;
    status = "offline";
    if (banned) {
      wantOnline = false;
      log("looks like a ban, not reconnecting");
      return;
    }
    if (!wantOnline) {
      log(`left the server (${reason})`);
      return;
    }
    log(`disconnected (${reason}), retrying in ${delay / 1000}s`);
    reconnectTimer = setTimeout(start, delay);
    delay = Math.min(delay * 2, 300000);
  });
}

// ---------- MCP server ----------
function text(t) {
  return { content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] };
}

function buildServer() {
  const s = new McpServer({ name: "minecraft-bot", version: "1.0.0" });

  s.tool("status", "Bot connection status, position, health and recent events", {}, async () => {
    const p = bot && bot.entity ? bot.entity.position : null;
    return text({
      status,
      username: USERNAME,
      server: `${HOST}:${PORT}`,
      health: bot ? bot.health : null,
      food: bot ? bot.food : null,
      position: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
      recentEvents: events.slice(-10),
    });
  });

  s.tool(
    "recent_chat",
    "Recent chat and system messages the bot received",
    { limit: z.number().int().min(1).max(100).optional() },
    async ({ limit }) => text(chatLog.slice(-(limit || 20)))
  );

  s.tool(
    "say",
    "Send a chat message or a command (start with /) as the bot",
    { message: z.string().min(1).max(250) },
    async ({ message }) => {
      if (!bot || status !== "online") return text("Bot is not in the world.");
      if (message.includes(PASSWORD)) return text("Refusing to send the bot's password.");
      bot.chat(message);
      return text("Sent: " + message);
    }
  );

  s.tool("players", "List players the bot can see on the server", {}, async () => {
    if (!bot) return text("Bot is offline.");
    return text(Object.keys(bot.players));
  });

  s.tool("inventory", "List items in the bot's inventory", {}, async () => {
    if (!bot || !bot.inventory) return text("Bot is offline.");
    return text(bot.inventory.items().map((i) => ({ name: i.name, count: i.count })));
  });

  s.tool("leave", "Disconnect the bot from the server and stop auto-reconnecting", {}, async () => {
    wantOnline = false;
    clearTimeout(reconnectTimer);
    if (bot) bot.quit();
    else status = "offline";
    return text("Leaving the server.");
  });

  s.tool("join", "Connect the bot to the server (if it is offline)", {}, async () => {
    wantOnline = true;
    delay = 15000;
    if (!bot) start();
    return text("Joining the server.");
  });

  s.tool(
    "scan_chests",
    "Walk to nearby chests and remember what is inside each one, for building from a schematic",
    { radius: z.number().int().min(1).max(48).optional() },
    async ({ radius }) => {
      if (!builder) return text("Bot is not in the world.");
      const n = await builder.scanChests(radius || 16);
      const totals = builder.chestSummary();
      return text({ chestsScanned: n, totals: Object.fromEntries(totals) });
    }
  );

  s.tool("chest_memory", "Show all chests the bot has scanned and their contents", {}, async () => {
    if (!builder) return text("Bot is not in the world.");
    const out = [...builder.chests.values()].map((c) => ({ pos: c.pos, items: Object.fromEntries(c.items) }));
    return text(out);
  });

  s.tool(
    "build_preview",
    "Show what the currently loaded schematic needs, and how that compares to remembered chest contents",
    {},
    async () => {
      if (!builder || !builder.job) return text("No schematic loaded yet. Upload one to /schematic/<secret> first.");
      const missing = builder.diffAgainstChests();
      return text({
        totalBlocks: builder.job.blocks.length,
        needed: Object.fromEntries([...builder.job.needed]),
        missingFromChests: missing,
      });
    }
  );

  s.tool(
    "build_start",
    "Start (or resume) building the loaded schematic using remembered chests for materials",
    {
      offsetX: z.number().int().optional(),
      offsetY: z.number().int().optional(),
      offsetZ: z.number().int().optional(),
    },
    async ({ offsetX, offsetY, offsetZ }) => {
      if (!builder || !builder.job) return text("No schematic loaded yet.");
      builder
        .runBuild({ x: offsetX || 0, y: offsetY || 0, z: offsetZ || 0 })
        .then((r) => log(`build finished: ${JSON.stringify(r)}`))
        .catch((e) => log("build error: " + e.message));
      return text("Build started in the background. Use build_status to check progress.");
    }
  );

  s.tool("build_status", "Check progress of the current build job", {}, async () => {
    if (!builder) return text("Bot is not in the world.");
    return text(builder.status());
  });

  s.tool("build_stop", "Pause the current build job after the block in progress finishes", {}, async () => {
    if (!builder) return text("Bot is not in the world.");
    builder.stopBuild();
    return text("Stopping after the current block.");
  });

  return s;
}

const app = express();
app.use(express.json());

// Simple status page that does not expose chat or credentials.
app.get("/", (req, res) => {
  res.type("text/plain").send(`status: ${status}\n`);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post(`/schematic/${MCP_SECRET}`, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no file uploaded (field name: file)" });
    if (!builder) return res.status(409).json({ error: "bot is not in the world yet" });
    const info = await builder.loadSchematic(req.file.buffer);
    log(`schematic loaded: ${info.blockCount} blocks`);
    res.json(info);
  } catch (e) {
    log("schematic load error: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

const route = `/mcp/${MCP_SECRET}`;
app.post(route, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log("mcp error: " + e.message);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});
const notAllowed = (req, res) => res.status(405).json({ error: "Method not allowed" });
app.get(route, notAllowed);
app.delete(route, notAllowed);

app.listen(process.env.PORT || 3000, () => log("HTTP server listening"));
start();
