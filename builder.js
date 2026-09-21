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

    const palette = region.BlockStatePalette.map((p) => {
      const props = p.Properties
        ? Object.entries(p.Properties).map(([k, v]) => `${k}=${v}`).join(",")
        : "";
      return { name: p.Name, propsStr: props };
    });
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
          blocks.push({ x: wx, y: wy, z: wz, name: entry.name });
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
  constructor(bot, log) {
    this.bot = bot;
    this.log = log;
    this.chests = new Map(); // "x,y,z" -> { pos, items: Map<name,count> }
    this.job = null; // { blocks, needed, placed, missing, running, paused }
    bot.loadPlugin(pathfinder);
  }

  setMovements() {
    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot, mcData);
    this.bot.pathfinder.setMovements(movements);
  }

  async gotoNear(pos, range = 2) {
    this.setMovements();
    await this.bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range));
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
        await this.gotoNear(pos, 2);
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
    return { blockCount: blocks.length, needed: Object.fromEntries([...needed].map(([k, v]) => [shortName(k), v])) };
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
    await this.gotoNear(pos, 2);
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

  async placeOne(target, name) {
    const { Vec3 } = require("vec3");
    const pos = new Vec3(target.x, target.y, target.z);
    const existing = this.bot.blockAt(pos);
    if (existing && existing.name === shortName(name)) return "already-correct";

    await this.gotoNear(pos, 3);
    const item = this.bot.inventory.items().find((i) => i.name === shortName(name));
    if (!item) return "no-item";

    await this.bot.equip(item, "hand");
    // Find a neighboring solid block to place against.
    const offsets = [
      [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    ];
    for (const [dx, dy, dz] of offsets) {
      const refPos = pos.offset(dx, dy, dz);
      const refBlock = this.bot.blockAt(refPos);
      if (refBlock && refBlock.boundingBox === "block") {
        try {
          await this.bot.placeBlock(refBlock, new Vec3(-dx, -dy, -dz));
          return "placed";
        } catch (e) {
          continue;
        }
      }
    }
    return "no-support";
  }

  async runBuild(originOffset = { x: 0, y: 0, z: 0 }) {
    if (!this.job) throw new Error("No schematic loaded.");
    if (this.job.running) throw new Error("Build already running.");
    this.job.running = true;
    this.job.paused = false;
    this.job.missing = [];

    const blocks = this.job.blocks;
    for (let i = this.job.placed; i < blocks.length; i++) {
      if (this.job.paused) {
        this.job.running = false;
        return { stopped: true, placed: this.job.placed, total: blocks.length };
      }
      const b = blocks[i];
      const target = { x: b.x + originOffset.x, y: b.y + originOffset.y, z: b.z + originOffset.z };
      const shortN = shortName(b.name);

      const have = this.bot.inventory.items().find((it) => it.name === shortN);
      if (!have) {
        const chest = this.findChestWith(b.name, 1);
        if (!chest) {
          this.job.missing.push(shortN);
          this.job.placed = i + 1;
          continue;
        }
        await this.withdrawFromChest(chest, b.name, 64);
      }

      const result = await this.placeOne(target, b.name);
      this.log(`block ${i + 1}/${blocks.length} (${shortN}) at ${target.x},${target.y},${target.z}: ${result}`);
      this.job.placed = i + 1;
    }
    this.job.running = false;
    return { stopped: false, placed: this.job.placed, total: blocks.length, missing: [...new Set(this.job.missing)] };
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
    };
  }
}

module.exports = { Builder, parseLitematic };
