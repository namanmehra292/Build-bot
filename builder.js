// Lightweight schematic builder: reads a .litematic file, remembers chest
// contents the bot has scanned, and places blocks by walking to the right
// chest, withdrawing materials, walking to the target position, and placing.
//
// Kept intentionally minimal: no undo, no rotation UI, no multi-region
// merging beyond concatenating regions as the litematic format already does.

const zlib = require("zlib");
const nbt = require("prismarine-nbt");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");

function readVarIntArray(buf) {
  // Litematica stores block state palette indices as a packed long array;
  // prismarine-nbt gives us the raw long[] (as arrays of two 32-bit ints).
  return buf;
}

// Unpack a bit-packed array of `count` entries, each `bitsPerEntry` wide,
// stored in `longs` (array of BigInt64-compatible [hi, lo] pairs from NBT).
function unpackLongArray(longs, bitsPerEntry, count) {
  const bigLongs = longs.map(([hi, lo]) => {
    const big = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return big;
  });
  const mask = (1n << BigInt(bitsPerEntry)) - 1n;
  const out = new Array(count);
  let bitIndex = 0;
  for (let i = 0; i < count; i++) {
    const longIndex = Math.floor(bitIndex / 64);
    const bitOffset = BigInt(bitIndex % 64);
    let value = (bigLongs[longIndex] >> bitOffset) & mask;
    const bitsLeftInLong = 64 - (bitIndex % 64);
    if (bitsLeftInLong < bitsPerEntry && longIndex + 1 < bigLongs.length) {
      const remaining = bitsPerEntry - bitsLeftInLong;
      const nextPart = bigLongs[longIndex + 1] & ((1n << BigInt(remaining)) - 1n);
      value |= nextPart << BigInt(bitsLeftInLong);
    }
    out[i] = Number(value & mask);
    bitIndex += bitsPerEntry;
  }
  return out;
}

function bitsNeeded(paletteSize) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(paletteSize, 2))));
}

// Parse a .litematic buffer into { blocks: [{x,y,z,name}], size, needed: Map<name,count> }
async function parseLitematic(buffer) {
  const decompressed = zlib.gunzipSync(buffer);
  const { parsed } = await nbt.parse(decompressed);
  const root = nbt.simplify(parsed);

  const regions = root.Regions;
  const blocks = [];
  const needed = new Map();

  for (const regionName of Object.keys(regions)) {
    const region = regions[regionName];
    const pos = region.Position;
    const size = region.Size;
    const ox = pos.x, oy = pos.y, oz = pos.z;
    const sx = size.x, sy = size.y, sz = size.z;
    const width = Math.abs(sx), height = Math.abs(sy), depth = Math.abs(sz);
    const volume = width * height * depth;

    const palette = region.BlockStatePalette.map((p) => ({
      name: p.Name,
      props: p.Properties || null,
    }));
    const bits = bitsNeeded(palette.length);

    // BlockStates comes back from nbt.simplify as an array of [hi, lo] pairs
    // when it's a long array; grab the raw long tag instead to be safe.
    const rawLongs = parsed.value.Regions.value.value[regionName].value.BlockStates.value.value;
    const longPairs = rawLongs.map((l) => (Array.isArray(l) ? l : [l.value ? l.value[0] : 0, l.value ? l.value[1] : 0]));
    const indices = unpackLongArray(longPairs, bits, volume);

    let i = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < depth; z++) {
        for (let x = 0; x < width; x++) {
          const idx = indices[i++];
          const entry = palette[idx];
          if (!entry || entry.name === "minecraft:air") continue;
          const wx = ox + (sx < 0 ? -x : x);
          const wy = oy + (sy < 0 ? -y : y);
          const wz = oz + (sz < 0 ? -z : z);
          blocks.push({ x: wx, y: wy, z: wz, name: entry.name, props: entry.props });
          needed.set(entry.name, (needed.get(entry.name) || 0) + 1);
        }
      }
    }
  }

  return { blocks, needed };
}

function shortName(mcName) {
  return mcName.replace(/^minecraft:/, "");
}

class Builder {
  // No bot required up front: the same Builder instance survives reconnects,
  // so a build's progress, chest memory and scaffold tracking are never lost
  // just because the connection dropped. Call setBot() whenever a new bot
  // instance comes online (initial join and every reconnect).
  constructor(log) {
    this.bot = null;
    this.log = log;
    this.chests = new Map(); // "x,y,z" -> { pos, items: Map<name,count> }
    this.job = null; // { blocks, needed, placed, missing, running, paused, offset }
    this.scaffold = new Set(); // "x,y,z" of temporary blocks placed to reach a spot
    this.resumeOnSpawn = false; // was mid-build when we got disconnected
  }

  setBot(bot) {
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    if (this.resumeOnSpawn && this.job) {
      this.resumeOnSpawn = false;
      this.log("reconnected mid-build, resuming automatically");
      this.runBuild(this.job.offset || { x: 0, y: 0, z: 0 }).catch((e) =>
        this.log("resumed build error: " + e.message)
      );
    }
  }

  // Called when the connection drops while a build is running, so we know
  // to pick back up automatically once setBot() is called again.
  onDisconnected() {
    if (this.job && this.job.running) {
      this.job.running = false;
      this.resumeOnSpawn = true;
      this.log("disconnected mid-build, will resume automatically on reconnect");
    }
  }

  setMovements() {
    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot, mcData);
    this.bot.pathfinder.setMovements(movements);
  }

  // Pause building (without treating it as a failure) while food/health is
  // dangerously low, eating from inventory if possible, and resuming once
  // it's safe. Bounded wait so a truly stuck situation still surfaces
  // rather than hanging forever silently.
  async waitIfUnsafe() {
    const start = Date.now();
    while (this.bot.health <= 6 || this.bot.food <= 3) {
      if (Date.now() - start > 120000) {
        this.log("health/food still low after 2 minutes of waiting, continuing anyway");
        return;
      }
      if (this.bot.food <= 14) {
        const foodItem = this.bot.inventory
          .items()
          .find((i) => /bread|apple|carrot|potato|beef|pork|chicken|mutton|cod|salmon|stew/.test(i.name));
        if (foodItem) {
          try {
            await this.bot.equip(foodItem, "hand");
            await this.bot.consume();
          } catch (e) {
            /* best effort */
          }
        }
      }
      this.log(`pausing: health=${this.bot.health} food=${this.bot.food}, waiting to recover`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  async gotoNear(pos, range = 2, timeoutMs = 20000) {
    this.setMovements();
    const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range);
    await Promise.race([
      this.bot.pathfinder.goto(goal),
      new Promise((_, reject) => setTimeout(() => reject(new Error("goto timeout")), timeoutMs)),
    ]);
  }

  // Place one block directly under the bot's feet by jumping and placing
  // mid-air against the block it just left. Standard "pillar jump" technique.
  // Tracked as scaffold so it gets removed once the build finishes.
  async pillarUpOnce(junk, log) {
    const { Vec3 } = require("vec3");
    const startBelow = this.bot.entity.position.offset(0, -1, 0).floored();
    const belowBlock = this.bot.blockAt(startBelow);
    if (!belowBlock || belowBlock.boundingBox !== "block") return false;
    await this.bot.equip(junk, "hand");
    this.bot.setControlState("jump", true);
    const start = Date.now();
    // Wait until the bot has risen enough to place below itself without
    // colliding with its own hitbox, but bail out if something's wrong.
    while (this.bot.entity.position.y < startBelow.y + 1.2) {
      if (Date.now() - start > 2000) {
        this.bot.setControlState("jump", false);
        return false;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      await this.bot.placeBlock(belowBlock, new Vec3(0, 1, 0));
      const placedAt = startBelow.offset(0, 1, 0);
      this.scaffold.add(`${placedAt.x},${placedAt.y},${placedAt.z}`);
      if (log) log(`pillared up to ${placedAt.x},${placedAt.y},${placedAt.z}`);
      return true;
    } catch (e) {
      return false;
    } finally {
      this.bot.setControlState("jump", false);
    }
  }

  // Try to reach `pos`. If the normal path fails, alternate short bridging
  // (horizontal gaps) and pillaring (vertical gaps, climbing straight up)
  // toward the target for a bounded number of steps, retrying the real
  // pathfinder goto after each adjustment. Every temporary block placed
  // this way is tracked and removed once the build finishes.
  async gotoNearOrBridge(pos, range, log) {
    try {
      await this.gotoNear(pos, range);
      return true;
    } catch (e) {
      const { Vec3 } = require("vec3");
      const junk = this.bot.inventory
        .items()
        .find((i) => /dirt|cobblestone|netherrack|stone|planks/.test(i.name));
      if (!junk) return false;

      const MAX_STEPS = 12;
      for (let step = 0; step < MAX_STEPS; step++) {
        const foot = this.bot.entity.position.floored();
        const dir = pos.minus(foot);

        if (dir.y > 1) {
          // Target is above us: pillar up.
          const ok = await this.pillarUpOnce(junk, log);
          if (!ok) break;
        } else if (Math.abs(dir.x) + Math.abs(dir.z) > range) {
          // Target is horizontally distant: bridge one step toward it.
          const bStep = new Vec3(Math.sign(dir.x) || 0, 0, Math.sign(dir.z) || 0);
          const bridgeAt = foot.offset(bStep.x, -1, bStep.z);
          const existing = this.bot.blockAt(bridgeAt);
          if (!existing || existing.boundingBox === "block") break; // already solid or unreadable, stop guessing
          try {
            await this.bot.equip(junk, "hand");
            const below = this.bot.blockAt(foot.offset(0, -1, 0));
            if (!below || below.boundingBox !== "block") break;
            await this.bot.placeBlock(below, new Vec3(bStep.x, 0, bStep.z));
            this.scaffold.add(`${bridgeAt.x},${bridgeAt.y},${bridgeAt.z}`);
            if (log) log(`bridged toward ${pos.x},${pos.y},${pos.z} with a temporary block`);
          } catch (e2) {
            break;
          }
        } else {
          break; // close enough that pathfinder should take it from here
        }

        try {
          await this.gotoNear(pos, range, 6000);
          return true;
        } catch (e3) {
          continue; // keep adjusting
        }
      }

      try {
        await this.gotoNear(pos, range);
        return true;
      } catch (e4) {
        return false;
      }
    }
  }

  // Scan chests within radius blocks of the bot's current position.
  async scanChests(radius = 16) {
    const { Vec3 } = require("vec3");
    const origin = this.bot.entity.position;
    const positions = this.bot.findBlocks({
      matching: (block) => block && (block.name === "chest" || block.name === "trapped_chest"),
      maxDistance: radius,
      count: 200,
    });

    let scanned = 0;
    for (const p of positions) {
      const pos = new Vec3(p.x, p.y, p.z);
      try {
        const reached = await this.gotoNearOrBridge(pos, 2, this.log);
        if (!reached) {
          this.log(`could not reach chest at ${pos.x},${pos.y},${pos.z}, skipping`);
          continue;
        }
        const block = this.bot.blockAt(pos);
        const container = await this.bot.openContainer(block);
        const items = new Map();
        for (const item of container.containerItems()) {
          items.set(item.name, (items.get(item.name) || 0) + item.count);
        }
        container.close();
        this.chests.set(`${pos.x},${pos.y},${pos.z}`, { pos: { x: pos.x, y: pos.y, z: pos.z }, items });
        scanned++;
        this.log(`scanned chest at ${pos.x},${pos.y},${pos.z}: ${[...items.entries()].map(([k, v]) => `${k}x${v}`).join(", ") || "empty"}`);
      } catch (e) {
        this.log(`failed to scan chest at ${pos.x},${pos.y},${pos.z}: ${e.message}`);
      }
    }
    return scanned;
  }

  chestSummary() {
    const totals = new Map();
    for (const { items } of this.chests.values()) {
      for (const [name, count] of items) totals.set(name, (totals.get(name) || 0) + count);
    }
    return totals;
  }

  async loadSchematic(buffer) {
    const { blocks, needed } = await parseLitematic(buffer);
    this.job = { blocks, needed, placed: 0, missing: [], running: false, paused: false };
    const riskyTypes = new Set(["minecraft:rail", "minecraft:powered_rail", "minecraft:detector_rail",
      "minecraft:activator_rail", "minecraft:redstone_wire"]);
    const risky = [...needed.keys()].filter((n) => riskyTypes.has(n)).map(shortName);
    return {
      blockCount: blocks.length,
      needed: Object.fromEntries([...needed].map(([k, v]) => [shortName(k), v])),
      orientationRisk: risky.length
        ? `${risky.join(", ")} auto-shape from neighbors and may not come out as designed - check after building`
        : null,
    };
  }

  diffAgainstChests() {
    if (!this.job) return null;
    const have = this.chestSummary();
    const missing = [];
    for (const [name, count] of this.job.needed) {
      const got = have.get(name) || 0;
      if (got < count) missing.push({ name: shortName(name), need: count, have: got, short: count - got });
    }
    return missing;
  }

  findChestWith(name, amount) {
    for (const entry of this.chests.values()) {
      const have = entry.items.get(name) || 0;
      if (have >= 1) return entry;
    }
    return null;
  }

  async withdrawFromChest(chestEntry, name, amount) {
    const { Vec3 } = require("vec3");
    const pos = new Vec3(chestEntry.pos.x, chestEntry.pos.y, chestEntry.pos.z);
    const reached = await this.gotoNearOrBridge(pos, 2, this.log);
    if (!reached) return 0;
    const block = this.bot.blockAt(pos);
    const container = await this.bot.openContainer(block);
    const slot = container.containerItems().find((i) => i.name === name);
    if (!slot) {
      container.close();
      return 0;
    }
    const take = Math.min(amount, slot.count);
    await container.withdraw(slot.type, null, take);
    container.close();
    const have = chestEntry.items.get(name) || 0;
    chestEntry.items.set(name, have - take);
    return take;
  }

  // Horizontal facing -> yaw the bot should look before placing, for blocks
  // (hopper, piston, observer, dispenser, repeater, comparator, chest...)
  // whose horizontal orientation follows the placer's look direction when
  // placed against a vertical (up/down) reference face.
  static FACING_YAW = {
    north: Math.PI,
    south: 0,
    east: -Math.PI / 2,
    west: Math.PI / 2,
  };

  async placeOne(target, name, props) {
    const { Vec3 } = require("vec3");
    const pos = new Vec3(target.x, target.y, target.z);
    const shortN = shortName(name);
    const existing = this.bot.blockAt(pos);

    const propsMatch = (block) => {
      if (!props || !block || !block.getProperties) return true;
      const actual = block.getProperties();
      for (const k of Object.keys(props)) {
        if (String(actual[k]) !== String(props[k])) return false;
      }
      return true;
    };

    if (existing && existing.name === shortN && propsMatch(existing)) return "already-correct";
    if (existing && existing.name !== "air" && existing.name !== shortN) {
      try {
        if (await this.gotoNearOrBridge(pos, 3, this.log)) await this.bot.dig(existing, true);
      } catch (e) {
        /* best effort */
      }
    }

    const reached = await this.gotoNearOrBridge(pos, 3, this.log);
    if (!reached) return "unreachable";
    const item = this.bot.inventory.items().find((i) => i.name === shortN);
    if (!item) return "no-item";
    await this.bot.equip(item, "hand");

    const wantsHorizontal = props && props.facing && Builder.FACING_YAW[props.facing] !== undefined;
    const offsets = wantsHorizontal
      ? [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      : [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

    let placedOk = false;
    for (const [dx, dy, dz] of offsets) {
      const refPos = pos.offset(dx, dy, dz);
      const refBlock = this.bot.blockAt(refPos);
      if (!refBlock || refBlock.boundingBox !== "block") continue;
      try {
        if (wantsHorizontal) {
          // Look away from the desired facing direction before placing:
          // most facing= blocks orient to point away from the placer.
          await this.bot.look(Builder.FACING_YAW[props.facing], 0, true);
        }
        await this.bot.placeBlock(refBlock, new Vec3(-dx, -dy, -dz));
        placedOk = true;
        break;
      } catch (e) {
        continue;
      }
    }
    if (!placedOk) return "no-support";

    // Verify; if the game picked a different facing than requested, note it
    // rather than looping forever (rails/rotation-sensitive blocks in
    // particular auto-shape based on neighbors and can't always be forced).
    const placed = this.bot.blockAt(pos);
    if (propsMatch(placed)) return "placed";
    return "placed-facing-uncertain";
  }

  // Never lets a single block hang the whole job: each block gets a bounded
  // number of attempts (pathing/placement errors caught individually), then
  // is recorded as skipped and the loop moves on. A per-block wall-clock cap
  // guards against a single stuck action (e.g. bad pathfinder state) hanging
  // forever even within an attempt.
  async runBuild(originOffset = { x: 0, y: 0, z: 0 }) {
    if (!this.job) throw new Error("No schematic loaded.");
    if (this.job.running) throw new Error("Build already running.");
    this.job.running = true;
    this.job.paused = false;
    this.job.offset = originOffset;
    this.job.missing = this.job.missing || [];
    this.job.skipped = this.job.skipped || [];

    const blocks = this.job.blocks;
    const MAX_ATTEMPTS = 3;
    const PER_ATTEMPT_TIMEOUT = 45000;

    for (let i = this.job.placed; i < blocks.length; i++) {
      if (this.job.paused) {
        await this.cleanupScaffold();
        this.job.running = false;
        return { stopped: true, placed: this.job.placed, total: blocks.length };
      }
      if (!this.bot || !this.bot.entity) {
        // Connection dropped out from under us; stop cleanly and let
        // setBot() on the next reconnect pick this back up automatically.
        this.job.running = false;
        this.resumeOnSpawn = true;
        this.log("bot not connected, pausing build until reconnect");
        return { stopped: true, disconnected: true, placed: this.job.placed, total: blocks.length };
      }
      await this.waitIfUnsafe();
      const b = blocks[i];
      const target = { x: b.x + originOffset.x, y: b.y + originOffset.y, z: b.z + originOffset.z };
      const shortN = shortName(b.name);

      let result = "skipped";
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const have = this.bot.inventory.items().find((it) => it.name === shortN);
          if (!have) {
            const chest = this.findChestWith(b.name, 1);
            if (!chest) {
              result = "no-material";
              break;
            }
            await this.withdrawFromChest(chest, b.name, 64);
          }
          result = await Promise.race([
            this.placeOne(target, b.name, b.props),
            new Promise((_, reject) => setTimeout(() => reject(new Error("placement timeout")), PER_ATTEMPT_TIMEOUT)),
          ]);
          if (result === "placed" || result === "already-correct" || result === "placed-facing-uncertain") break;
          // "no-support" / "unreachable" / "no-item": worth a retry in case a
          // neighbor gets placed later in a future pass, but don't loop forever now.
        } catch (e) {
          result = "error: " + e.message;
          this.log(`attempt ${attempt}/${MAX_ATTEMPTS} failed for block ${i + 1} (${shortN}): ${e.message}`);
        }
      }

      this.log(`block ${i + 1}/${blocks.length} (${shortN}) at ${target.x},${target.y},${target.z}: ${result}`);
      if (result === "no-material") this.job.missing.push(shortN);
      else if (result !== "placed" && result !== "already-correct" && result !== "placed-facing-uncertain") {
        this.job.skipped.push({ index: i, name: shortN, pos: target, reason: result });
      }
      this.job.placed = i + 1;
    }

    await this.cleanupScaffold();
    this.job.running = false;
    return {
      stopped: false,
      placed: this.job.placed,
      total: blocks.length,
      missing: [...new Set(this.job.missing)],
      skipped: this.job.skipped,
    };
  }

  // Break every temporary bridging block placed during the build. Only
  // removes blocks this run actually placed for scaffolding, and only if
  // the schematic itself didn't legitimately want a block there.
  async cleanupScaffold() {
    const { Vec3 } = require("vec3");
    const schemPositions = new Set((this.job ? this.job.blocks : []).map((b) => `${b.x},${b.y},${b.z}`));
    for (const key of [...this.scaffold]) {
      if (schemPositions.has(key)) {
        this.scaffold.delete(key);
        continue;
      }
      const [x, y, z] = key.split(",").map(Number);
      const pos = new Vec3(x, y, z);
      try {
        const reached = await this.gotoNearOrBridge(pos, 3, this.log);
        if (reached) {
          const block = this.bot.blockAt(pos);
          if (block && block.name !== "air") await this.bot.dig(block, true);
        }
        this.log(`removed temporary scaffold block at ${x},${y},${z}`);
      } catch (e) {
        this.log(`could not remove scaffold block at ${x},${y},${z}: ${e.message}`);
      }
      this.scaffold.delete(key);
    }
  }

  stopBuild() {
    if (this.job) this.job.paused = true;
  }

  status() {
    if (!this.job) return { loaded: false };
    return {
      loaded: true,
      running: this.job.running,
      placed: this.job.placed,
      total: this.job.blocks.length,
      missing: [...new Set(this.job.missing)],
      skippedCount: (this.job.skipped || []).length,
      skipped: (this.job.skipped || []).slice(-20), // most recent, to keep responses small
      scaffoldRemaining: this.scaffold.size,
    };
  }
}

module.exports = { Builder, parseLitematic };
