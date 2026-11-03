#!/usr/bin/env node
// Builds the profile: SVG panels in profile/generated/ and README.md, from
// profile.config.json plus live GitHub, npm and blog data. Standard library
// only. .github/workflows/refresh.yml runs it once a day.
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/build-profile.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (p) => path.join(ROOT, p);
const config = JSON.parse(readFileSync(at("profile.config.json"), "utf8"));
const USER = config.user;
const OUT = at("profile/generated");
const CACHE = at("profile/cache.json");

/* ── Theme ────────────────────────────────────────────────────────────── */

// The dark tokens from junaidshaukat.com, so the profile and the site match.
const T = {
  panel: "#111214",
  well: "#0c0d0f",
  line: "#26282c",
  faint: "#1c1d20",
  text1: "#f2f3f4",
  text2: "#a1a5ac",
  text3: "#80858d",
  accent: "#47b990",
  accentInk: "#06231a",
  aurora: ["#10201a", "#163426", "#1e5340", "#2b7d5d", "#47b990", "#8ff0d0"],
};

const CODE = {
  k: "#a5b4fc", // keyword
  f: "#f2f3f4", // function
  s: "#7cebcb", // string / highlight
  c: "#80858d", // comment / prompt
  p: "#a1a5ac", // punctuation / plain
};

/* ── Fonts ────────────────────────────────────────────────────────────── */

// SVGs in a README load as images and cannot fetch fonts, so each panel embeds
// the latin woff2 it uses. The .ttf copies are only read for glyph widths, so
// text can be wrapped and fitted exactly.
const FONTS = {
  mono: { family: "GeistMono", file: "geist-mono" },
  sans: { family: "InstrumentSans", file: "instrument-sans" },
  sansMd: { family: "InstrumentSansMd", file: "instrument-sans-500" },
  hand: { family: "GochiHand", file: "gochi-hand" },
};

function parseTtf(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => dv.getUint16(o);
  const i16 = (o) => dv.getInt16(o);
  const tables = {};
  for (let i = 0; i < u16(4); i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(...buf.subarray(rec, rec + 4));
    tables[tag] = dv.getUint32(rec + 8);
  }
  const upm = u16(tables.head + 18);
  const nMetrics = u16(tables.hhea + 34);
  const advances = [];
  for (let i = 0; i < nMetrics; i++) advances.push(u16(tables.hmtx + 4 * i));

  // cmap format 4 (Windows Unicode BMP) is enough for latin text.
  const cmap = tables.cmap;
  let sub = null;
  for (let i = 0; i < u16(cmap + 2); i++) {
    const rec = cmap + 4 + 8 * i;
    const off = cmap + dv.getUint32(rec + 4);
    if (u16(rec) === 3 && u16(rec + 2) === 1 && u16(off) === 4) sub = off;
  }
  const segX2 = u16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;

  const glyph = (code) => {
    for (let s = 0; s < segX2; s += 2) {
      if (u16(ends + s) < code) continue;
      const start = u16(starts + s);
      if (start > code) return 0;
      const delta = i16(deltas + s);
      const ro = u16(ranges + s);
      if (ro === 0) return (code + delta) & 0xffff;
      const g = u16(ranges + s + ro + 2 * (code - start));
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  const cache = new Map();
  return (code) => {
    if (!cache.has(code)) {
      const g = glyph(code);
      if (g === 0 && code > 32) console.warn(`  missing glyph U+${code.toString(16)}`);
      cache.set(code, advances[Math.min(g, nMetrics - 1)] / upm);
    }
    return cache.get(code);
  };
}

for (const f of Object.values(FONTS)) {
  f.advance = parseTtf(readFileSync(at(`fonts/${f.file}.ttf`)));
  f.b64 = readFileSync(at(`fonts/${f.file}.woff2`)).toString("base64");
}

const measure = (font, str, size, spacing = 0) =>
  [...String(str)].reduce((w, ch) => w + FONTS[font].advance(ch.codePointAt(0)) * size + spacing, 0);

// The largest size, down to `min`, at which a single line fits.
function fit(str, font, size, maxWidth, min = 10) {
  while (size > min && measure(font, str, size) > maxWidth) size -= 0.5;
  return size;
}

function wrap(str, font, size, maxWidth, maxLines = Infinity) {
  const lines = [];
  let line = "";
  for (const word of String(str).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(font, next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && measure(font, `${last}…`, size) > maxWidth) last = last.replace(/\s*\S+$/, "");
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

/* ── SVG building blocks ──────────────────────────────────────────────── */

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v) => +v.toFixed(2);

// Each panel records which fonts it used, so it embeds only those.
let used = new Set();
let uid = 0;
const id = (p) => `${p}${++uid}`;

function text(x, y, str, { font = "sans", size = 14, fill = T.text1, anchor, spacing = 0, upper } = {}) {
  used.add(font);
  const s = upper ? String(str).toUpperCase() : str;
  return `<text xml:space="preserve" x="${n(x)}" y="${n(y)}" font-family="${FONTS[font].family}" font-size="${size}" fill="${fill}"${
    anchor ? ` text-anchor="${anchor}"` : ""
  }${spacing ? ` letter-spacing="${spacing}"` : ""}>${esc(s)}</text>`;
}

// Colored runs on one line, laid out with measured widths.
function runs(x, y, parts, { size = 12, colors = CODE } = {}) {
  let cx = x;
  let out = "";
  for (const [kind, str] of parts) {
    out += text(cx, y, str, { font: "mono", size, fill: colors[kind] ?? T.text1 });
    cx += measure("mono", str, size);
  }
  return out;
}

const rect = (x, y, w, h, { fill = "none", stroke, rx = 0, sw = 1 } = {}) =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${rx ? ` rx="${rx}"` : ""} fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""
  }/>`;
const hline = (x1, x2, y, color = T.line) => `<path d="M${n(x1)} ${n(y)}H${n(x2)}" stroke="${color}"/>`;
const vline = (x, y1, y2, color = T.line) => `<path d="M${n(x)} ${n(y1)}V${n(y2)}" stroke="${color}"/>`;

// A small north-east arrow, drawn rather than typed: the latin font subsets
// don't include arrow glyphs.
const arrow = (x, y, size, color) =>
  `<path d="M${n(x)} ${n(y + size)}L${n(x + size)} ${n(y)}M${n(x + size * 0.3)} ${n(y)}H${n(x + size)}V${n(
    y + size * 0.7
  )}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;

function dataUri(file) {
  const buf = Buffer.isBuffer(file) ? file : readFileSync(at(file));
  const ext = Buffer.isBuffer(file) ? "png" : path.extname(file).slice(1).toLowerCase();
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" }[ext];
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// An image clipped to a rounded rectangle. `inset` shrinks a logo that has
// no background of its own inside its tile.
function tile(x, y, size, href, { fill = "#ffffff", rx = 8, inset = 1, slice = true } = {}) {
  const clip = id("t");
  const pad = (size * (1 - inset)) / 2;
  return `<clipPath id="${clip}">${rect(x, y, size, size, { rx })}</clipPath>${rect(x, y, size, size, {
    rx,
    fill,
  })}<image href="${href}" x="${n(x + pad)}" y="${n(y + pad)}" width="${n(size - 2 * pad)}" height="${n(
    size - 2 * pad
  )}" preserveAspectRatio="xMidYMid ${slice ? "slice" : "meet"}" clip-path="url(#${clip})"/>${rect(x, y, size, size, {
    rx,
    stroke: "rgba(255,255,255,0.08)",
  })}`;
}

function svgDoc(w, h, body, { title, css = "" }) {
  const faces = [...used]
    .map((k) => `@font-face{font-family:${FONTS[k].family};src:url(data:font/woff2;base64,${FONTS[k].b64}) format("woff2")}`)
    .join("");
  used = new Set();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(
    title
  )}"><title>${esc(title)}</title><style>${faces}text{font-kerning:normal;white-space:pre}${css}</style>${body}</svg>`;
}

// Panel chrome: a rounded frame with a title bar. Returns the bar's markup.
function frame(x, y, w, h, label, right) {
  return [
    rect(x + 0.5, y + 0.5, w - 1, h - 1, { fill: T.panel, stroke: T.line, rx: 12 }),
    text(x + 18, y + 27, label, { font: "mono", size: 13, fill: T.text1 }),
    right ? text(x + w - 18, y + 27, right, { font: "mono", size: 12, fill: T.text3, anchor: "end" }) : "",
    hline(x + 1, x + w - 1, y + 43),
  ].join("");
}

/* ── Ordered dithering ────────────────────────────────────────────────── */

const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

// Quantises field(u, v) in [0, 1] onto the palette with an 8x8 Bayer matrix,
// merging same-colored cells in a row into one rectangle.
function dither({ x0 = 0, y0 = 0, cols, rows, cell, palette, field }) {
  const levels = palette.length;
  const paths = palette.map(() => []);
  for (let r = 0; r < rows; r++) {
    let runLevel = 0;
    let runStart = 0;
    for (let c = 0; c <= cols; c++) {
      let lv = 0;
      if (c < cols) {
        const v = Math.min(1, Math.max(0, field(c / cols, r / rows)));
        const q = v * levels;
        const base = Math.floor(q);
        lv = Math.min(levels, base + (q - base > (BAYER[r % 8][c % 8] + 0.5) / 64 ? 1 : 0));
      }
      if (lv !== runLevel) {
        if (runLevel > 0) {
          const w = (c - runStart) * cell;
          paths[runLevel - 1].push(`M${x0 + runStart * cell} ${y0 + r * cell}h${w}v${cell}h-${w}z`);
        }
        runLevel = lv;
        runStart = c;
      }
    }
  }
  return paths.map((d, i) => (d.length ? `<path fill="${palette[i]}" d="${d.join("")}"/>` : "")).join("");
}

const TAU = Math.PI * 2;
const gauss = (d, w) => Math.exp(-((d / w) ** 2));

/* ── Data ─────────────────────────────────────────────────────────────── */

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": USER, Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function github(pathname) {
  const token = process.env.GITHUB_TOKEN;
  return getJson(`https://api.github.com${pathname}`, {
    Accept: "application/vnd.github+json",
    ...(token && { Authorization: `Bearer ${token}` }),
  });
}

// A failed lookup falls back to the last good value instead of breaking the build.
async function cached(key, fn) {
  try {
    const value = await fn();
    cache[key] = value;
    return value;
  } catch (err) {
    if (key in cache) {
      console.warn(`  ${key}: ${err.message}; using cached value`);
      return cache[key];
    }
    throw err;
  }
}

/** Merged PRs into repositories the user does not own, counted per repo. */
async function mergedPullRequests() {
  const q = encodeURIComponent(`is:pr is:merged author:${USER} -user:${USER}`);
  const counts = {};
  let seen = 0;
  for (let page = 1; page <= 10; page++) {
    const { total_count, items } = await github(`/search/issues?q=${q}&per_page=100&page=${page}`);
    for (const item of items) {
      const repo = item.repository_url.split("/repos/")[1];
      counts[repo] = (counts[repo] ?? 0) + 1;
    }
    seen += items.length;
    if (items.length < 100 || seen >= total_count) break;
  }
  return counts;
}

const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** All-time npm downloads. The API caps a range at 18 months, so walk it in chunks. */
async function npmDownloads(pkg) {
  const meta = await getJson(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`);
  const end = Date.now() - DAY;
  let total = 0;
  for (let from = Date.parse(meta.time.created); from <= end; from += 500 * DAY) {
    const to = Math.min(from + 499 * DAY, end);
    const { downloads } = await getJson(`https://api.npmjs.org/downloads/point/${isoDate(from)}:${isoDate(to)}/${pkg}`);
    if (typeof downloads !== "number") throw new Error(`no download count for ${pkg}`);
    total += downloads;
  }
  return total;
}

async function latestPosts(feed, count) {
  const res = await fetch(feed, { headers: { "User-Agent": USER } });
  if (!res.ok) throw new Error(`${res.status} for ${feed}`);
  const xml = await res.text();
  const tag = (block, name) =>
    (block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) ?? [])[1]
      ?.replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, count).map(([, item]) => ({
    title: tag(item, "title"),
    url: tag(item, "link"),
    date: new Date(tag(item, "pubDate")).toISOString().slice(0, 10),
  }));
}

async function avatar(owner) {
  return cached(`avatar:${owner}`, async () => {
    const res = await fetch(`https://github.com/${owner}.png?size=64`);
    if (!res.ok) throw new Error(`${res.status} for avatar ${owner}`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  });
}

/* ── Formatting ───────────────────────────────────────────────────────── */

const compact = (v) => (v < 1000 ? String(v) : `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
};

// "{merged}", "{npm:pkg}", "{stars}"… filled from live data.
function fill(template, data, repo) {
  return String(template).replace(/\{([\w:@/.-]+)\}/g, (_, key) => {
    if (key.startsWith("npm:")) return compact(data.npm[key.slice(4)]);
    if (key === "merged") return String(data.merged);
    if (key === "npmTotal") return compact(data.npmTotal);
    if (key === "language") return repo?.language ?? "";
    if (key === "stars") return String(repo?.stars ?? "");
    if (key === "updated") return repo?.pushed ? shortDate(repo.pushed) : "";
    throw new Error(`unknown placeholder {${key}}`);
  });
}

/* ── Panels ───────────────────────────────────────────────────────────── */

const W = 860;

function header(data) {
  const p = config.profile;
  const auroraY = 44;
  const cell = 8;
  const tileCols = 112; // 896px: a multiple of the 8x8 matrix, so the tile wraps cleanly
  const rows = 19;
  const auroraH = rows * cell;
  const idY = auroraY + auroraH;
  const split = 500;

  // Identity block (left).
  const intro = wrap(p.intro, "sans", 16, split - 56);
  const nameY = idY + 66;
  const introY = nameY + 34;
  const factsY = introY + intro.length * 23 + 22;
  const leftBottom = factsY + p.facts.length * 26;

  // Stats grid (right): two by two.
  const cellH = 92;
  const H = Math.max(leftBottom + 10, idY + 2 * cellH) + 1;

  const glow = (u, v) => {
    const center = 0.52 + 0.16 * Math.sin(TAU * u + 0.6) + 0.07 * Math.sin(TAU * 3 * u + 1.7);
    const width = 0.2 + 0.05 * Math.sin(TAU * 2 * u);
    return gauss(v - center, width) * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(TAU * 2 * u + 0.3))) * 0.95;
  };
  const crest = (u, v) => {
    const center = 0.47 + 0.14 * Math.sin(TAU * 2 * u + 2.1);
    return gauss(v - center, 0.07) * (0.5 + 0.5 * Math.sin(TAU * 3 * u + 0.9)) ** 2;
  };
  const layer = (field, palette) =>
    [0, tileCols * cell]
      .map((dx) => dither({ x0: dx, y0: auroraY, cols: tileCols, rows, cell, palette, field }))
      .join("");

  const clip = id("aurora");
  const statusX = 18 + measure("mono", USER, 13) + 18;
  const stats = p.stats.map((s, i) => {
    const x = split + (i % 2) * ((W - split) / 2);
    const y = idY + Math.floor(i / 2) * cellH;
    return [
      text(x + 20, y + 26, s.label, { font: "mono", size: 10.5, fill: T.text3, spacing: 1, upper: true }),
      text(x + 20, y + 54, fill(s.value, data), { font: "mono", size: 19, fill: T.text1 }),
      text(x + 20, y + 74, s.sub, { font: "sans", size: 12.5, fill: T.text3 }),
    ].join("");
  });

  const body = [
    frame(0, 0, W, H, USER, p.site),
    // Status mark: four squares, one blinking.
    rect(statusX, 17, 4, 4, { fill: T.accent }),
    rect(statusX + 5, 17, 4, 4, { fill: T.accent }),
    rect(statusX, 22, 4, 4, { fill: T.accent }),
    `<g class="blink">${rect(statusX + 5, 22, 4, 4, { fill: T.accent })}</g>`,
    text(statusX + 16, 27, p.status, { font: "mono", size: 12, fill: T.text1, spacing: 1.2, upper: true }),
    // Aurora: two dithered layers drifting in opposite directions.
    `<clipPath id="${clip}"><rect x="1" y="${auroraY + 0.5}" width="${W - 2}" height="${auroraH}"/></clipPath>`,
    `<g clip-path="url(#${clip})">${rect(1, auroraY + 0.5, W - 2, auroraH, { fill: T.well })}`,
    `<g class="drift-a">${layer(glow, T.aurora.slice(0, 4))}</g>`,
    `<g class="drift-b">${layer(crest, T.aurora.slice(3))}</g></g>`,
    hline(1, W - 1, idY + 0.5),
    // Identity.
    text(28, nameY, p.name, { font: "hand", size: 52, fill: T.text1 }),
    ...intro.map((line, i) => text(28, introY + i * 23, line, { font: "sans", size: 16, fill: T.text2 })),
    ...p.facts.map((f, i) =>
      [
        text(28, factsY + i * 26, f.label, { font: "mono", size: 11, fill: T.text3, spacing: 1, upper: true }),
        text(110, factsY + i * 26, f.value, { font: "mono", size: 13.5, fill: T.text1 }),
      ].join("")
    ),
    // Stats grid lines.
    vline(split + 0.5, idY + 1, H - 1),
    vline(split + (W - split) / 2 + 0.5, idY + 1, H - 1),
    hline(split, W - 1, idY + cellH + 0.5),
    ...stats,
  ].join("");

  const css = `
.blink{animation:blink 1.6s steps(1) infinite}
@keyframes blink{50%{opacity:.15}}
.drift-a{animation:drift-a 72s steps(${tileCols}) infinite}
.drift-b{animation:drift-b 36s steps(${tileCols}) infinite}
@keyframes drift-a{from{transform:translateX(0)}to{transform:translateX(-${tileCols * cell}px)}}
@keyframes drift-b{from{transform:translateX(-${tileCols * cell}px)}to{transform:translateX(0)}}
@media (prefers-reduced-motion:reduce){.blink,.drift-a,.drift-b{animation:none}}`;

  return svgDoc(W, H, body, { title: `${p.name}. ${p.intro}`, css });
}

/* Banners for the project cards: 404 x 208. */

const BW = 404;
const BH = 208;

function bannerGlow(x, y, palette, field, cell = 6) {
  return dither({ x0: x, y0: y, cols: Math.ceil(BW / cell), rows: Math.ceil(BH / cell), cell, palette, field });
}

function banner(b, x, y) {
  const clip = id("b");
  let inner = "";

  if (b.type === "image") {
    inner = `<image href="${dataUri(b.src)}" x="${x}" y="${y}" width="${BW}" height="${BH}" preserveAspectRatio="xMidYMin slice"/>`;
  }

  if (b.type === "code") {
    inner = [
      rect(x, y, BW, BH, { fill: T.well }),
      bannerGlow(x, y, b.glow, (u, v) => (1 - Math.hypot((u - 1) * 1.1, v - 1.15) / 1.05) ** 1.6),
      tile(x + 20, y + 20, 40, dataUri(b.logo), { rx: 10, inset: 0.9 }),
      text(x + 72, y + 45, b.label ?? "", { font: "mono", size: 12.5, fill: T.text2 }),
      rect(x + 20, y + 80, BW - 40, 106, { fill: "rgba(8,9,10,0.82)", stroke: T.line, rx: 8 }),
      ...b.lines.map((parts, i) => runs(x + 34, y + 106 + i * 21, parts, { size: 11.5 })),
    ].join("");
  }

  if (b.type === "icon") {
    const size = 108;
    inner = [
      rect(x, y, BW, BH, { fill: T.well }),
      bannerGlow(x, y, b.glow, (u, v) => (1 - Math.hypot((u - 0.5) * 1.6, v - 0.42) / 0.75) ** 1.3),
      tile(x + (BW - size) / 2, y + 30, size, dataUri(b.src), { rx: 26, fill: "#ececec" }),
      text(x + BW / 2, y + 172, b.caption, { font: "mono", size: 12, fill: T.text2, anchor: "middle" }),
    ].join("");
  }

  if (b.type === "terminal") {
    inner = [
      rect(x, y, BW, BH, { fill: T.well }),
      bannerGlow(x, y, b.glow, (u, v) => (v - (0.52 + 0.16 * Math.sin(TAU * u * 1.5 + 1) + 0.07 * Math.sin(TAU * u * 5))) * 2.4),
      rect(x + 22, y + 22, 286, 132, { fill: "rgba(8,9,10,0.9)", stroke: T.line, rx: 8 }),
      ...[0, 1, 2].map((i) => `<circle cx="${x + 38 + i * 13}" cy="${y + 37}" r="4" fill="#33363b"/>`),
      hline(x + 23, x + 307, y + 51.5, T.faint),
      ...b.lines.map((parts, i) => runs(x + 36, y + 76 + i * 21, parts, { size: 12, colors: { ...CODE, s: "#f0a14a", p: T.text1 } })),
    ].join("");
  }

  return `<clipPath id="${clip}">${rect(x, y, BW, BH, { rx: 8 })}</clipPath><g clip-path="url(#${clip})">${inner}</g>${rect(
    x + 0.5,
    y + 0.5,
    BW - 1,
    BH - 1,
    { rx: 8, stroke: "rgba(255,255,255,0.07)" }
  )}`;
}

const CW = 430;
// Top bar 44, banner, title, three description lines, meta row, CTA row.
const CARD_DESC_Y = 5 + 44 + 8 + BH + 74;
const CARD_META_Y = CARD_DESC_Y + 3 * 21 + 8;
const CARD_CTA_Y = CARD_META_Y + 64;
const CARD_H = CARD_CTA_Y + 56 + 5;

function card(f, data) {
  const repo = f.repo ? data.repos[f.repo] : null;
  const x = 5;
  const y = 5;
  const w = CW - 10;
  const descY = CARD_DESC_Y;
  const desc = wrap(f.description, "sans", 14.5, w - 34, 3);
  const metaY = CARD_META_Y;
  const ctaY = CARD_CTA_Y;
  const cellW = w / 3;

  const ctaLabel = f.cta.toUpperCase();
  const btnW = measure("mono", ctaLabel, 11.5, 1) + 44;
  const btnX = x + w - 14 - btnW;

  const body = [
    frame(x, y, w, CARD_H - 10, f.name, f.kind.toUpperCase()),
    banner(f.banner, x + 8, y + 52),
    text(x + 18, y + 52 + BH + 46, f.name, { font: "sansMd", size: 26, fill: T.text1 }),
    ...desc.map((line, i) => text(x + 18, descY + i * 21, line, { font: "sans", size: 14.5, fill: T.text2 })),
    hline(x + 1, x + w - 1, metaY + 0.5),
    ...f.meta.map((m, i) =>
      [
        i ? vline(x + i * cellW + 0.5, metaY + 1, ctaY) : "",
        text(x + i * cellW + 16, metaY + 24, m.label, { font: "mono", size: 10, fill: T.text3, spacing: 0.8, upper: true }),
        (() => {
          const value = fill(m.value, data, repo);
          const size = fit(value, "mono", 14, cellW - 30);
          return text(x + i * cellW + 16, metaY + 46, value, { font: "mono", size, fill: T.text1 });
        })(),
      ].join("")
    ),
    hline(x + 1, x + w - 1, ctaY + 0.5),
    text(x + 18, ctaY + 32, f.host, { font: "mono", size: 12, fill: T.text3 }),
    rect(btnX, ctaY + 11, btnW, 32, { fill: T.accent, rx: 7 }),
    text(btnX + 16, ctaY + 31, ctaLabel, { font: "mono", size: 11.5, fill: T.accentInk, spacing: 1 }),
    arrow(btnX + btnW - 24, ctaY + 22.5, 8, T.accentInk),
  ].join("");

  return svgDoc(CW, CARD_H, body, { title: `${f.name}: ${f.description}` });
}

async function openSource(data) {
  const os = config.openSource;
  const countFor = (repos) => repos.reduce((sum, r) => sum + (data.counts[r] ?? 0), 0);
  const rows = os.projects
    .map((p, i) => ({ ...p, i, count: countFor(p.repos) }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count || a.i - b.i);

  const listed = new Set(os.projects.flatMap((p) => p.repos));
  const others = Object.keys(data.counts).filter((r) => !listed.has(r));

  const noteX = 330;
  const noteW = W - noteX - 28;
  const all = [
    ...(await Promise.all(
      rows.map(async (p) => ({
        name: p.name,
        logo: `data:image/png;base64,${await avatar(p.owner)}`,
        count: String(p.count),
        note: wrap(p.note, "sans", 13.5, noteW, 2),
      }))
    )),
    ...os.extra.map((e) => ({ name: e.name, logo: dataUri(e.logo), count: e.count, note: wrap(e.note, "sans", 13.5, noteW, 2) })),
  ];

  let y = 44 + 38;
  const lines = [];
  for (const r of all) {
    const h = Math.max(50, 18 + r.note.length * 20 + 12);
    const mid = y + h / 2;
    lines.push(
      hline(1, W - 1, y + 0.5, T.faint),
      tile(28, mid - 12, 24, r.logo, { rx: 6 }),
      text(64, mid + 5, r.name, { font: "sansMd", size: 15, fill: T.text1 }),
      text(232, mid + 5, r.count, { font: "mono", size: 14, fill: /^\d+$/.test(r.count) ? T.accent : T.text3 }),
      ...r.note.map((line, i) =>
        text(noteX, mid + 5 - ((r.note.length - 1) * 20) / 2 + i * 20, line, { font: "sans", size: 13.5, fill: T.text2 })
      )
    );
    y += h;
  }
  if (others.length) {
    lines.push(
      hline(1, W - 1, y + 0.5, T.faint),
      text(28, y + 28, `+ ${others.length} more in ${others.join(", ")}`, { font: "mono", size: 11.5, fill: T.text3 })
    );
    y += 44;
  }
  const H = y + 8;
  const orgs = new Set(Object.keys(data.counts).map((r) => r.split("/")[0])).size;

  const body = [
    frame(0, 0, W, H, "open source", `${data.merged} merged prs · ${orgs} orgs · refreshed daily`),
    text(28, 44 + 24, "project", { font: "mono", size: 10.5, fill: T.text3, spacing: 1, upper: true }),
    text(232, 44 + 24, "merged", { font: "mono", size: 10.5, fill: T.text3, spacing: 1, upper: true }),
    text(noteX, 44 + 24, "what I did", { font: "mono", size: 10.5, fill: T.text3, spacing: 1, upper: true }),
    ...lines,
  ].join("");

  const alt = `Open source: ${data.merged} merged pull requests. ${all.map((r) => `${r.name} (${r.count})`).join(", ")}.`;
  return svgDoc(W, H, body, { title: alt });
}

function community() {
  let y = 44;
  const rows = [];
  for (const c of config.community) {
    const detail = wrap(c.detail, "sans", 13.5, W - 100, 2);
    const h = 30 + 22 + detail.length * 19;
    rows.push(
      y > 44 ? hline(1, W - 1, y + 0.5, T.faint) : "",
      tile(28, y + 18, 38, dataUri(c.logo), { fill: c.tile, rx: 10, inset: c.inset ?? 1, slice: !c.inset }),
      text(82, y + 34, c.title, { font: "sansMd", size: 15, fill: T.text1 }),
      ...detail.map((line, i) => text(82, y + 55 + i * 19, line, { font: "sans", size: 13.5, fill: T.text2 }))
    );
    y += h;
  }
  const H = y + 10;
  const body = [frame(0, 0, W, H, "community", "events · ambassador programs"), ...rows].join("");
  return svgDoc(W, H, body, {
    title: `Community: ${config.community.map((c) => `${c.title}. ${c.detail}`).join(" ")}`,
  });
}

function writing(posts) {
  const wcfg = config.writing;
  const host = wcfg.url.replace(/^https?:\/\//, "");
  const rows = [
    { title: wcfg.pinned.title, right: wcfg.pinned.detail, pinned: true },
    ...posts.map((p) => ({ title: p.title, right: p.date })),
  ];
  let y = 44;
  const out = [];
  for (const r of rows) {
    out.push(
      y > 44 ? hline(1, W - 1, y + 0.5, T.faint) : "",
      r.pinned ? rect(28, y + 17, 52, 18, { rx: 4, fill: "rgba(71,185,144,0.14)" }) : "",
      r.pinned ? text(54, y + 30, "course", { font: "mono", size: 10, fill: T.accent, anchor: "middle", spacing: 0.8, upper: true }) : "",
      text(r.pinned ? 92 : 28, y + 31, r.title, { font: r.pinned ? "sansMd" : "sans", size: 15, fill: T.text1 }),
      text(W - 28, y + 31, r.right, { font: "mono", size: 12, fill: T.text3, anchor: "end" })
    );
    y += 50;
  }
  const H = y + 2;
  const body = [frame(0, 0, W, H, "writing", host), ...out].join("");
  return svgDoc(W, H, body, { title: `Writing: ${rows.map((r) => r.title).join("; ")}` });
}

function link(l) {
  const w = W / config.links.length;
  const h = 58;
  const label = l.label.toUpperCase();
  const tw = measure("mono", label, 12, 1.2) + 16;
  const x = (w - tw) / 2;
  const body = [
    rect(4.5, 4.5, w - 9, h - 9, { fill: T.panel, stroke: T.line, rx: 10 }),
    text(x, 34, label, { font: "mono", size: 12, fill: T.text1, spacing: 1.2 }),
    arrow(x + tw - 8, 24, 7, T.accent),
  ].join("");
  return svgDoc(n(w), h, body, { title: l.label });
}

/* ── Build ────────────────────────────────────────────────────────────── */

console.log("Fetching data…");
const counts = await cached("counts", mergedPullRequests);
const npm = {};
for (const pkg of config.npmPackages) npm[pkg] = await cached(`npm:${pkg}`, () => npmDownloads(pkg));
const repos = {};
for (const f of config.featured.filter((f) => f.repo)) {
  repos[f.repo] = await cached(`repo:${f.repo}`, async () => {
    const r = await github(`/repos/${f.repo}`);
    return { language: r.language, stars: r.stargazers_count, pushed: r.pushed_at };
  });
}
const posts = await cached("posts", () => latestPosts(config.writing.feed, config.writing.count));

const data = {
  counts,
  merged: Object.values(counts).reduce((a, b) => a + b, 0),
  npm,
  npmTotal: Object.values(npm).reduce((a, b) => a + b, 0),
  repos,
};
console.log(`  ${data.merged} merged PRs, ${data.npmTotal} npm downloads, ${posts.length} posts`);

console.log("Rendering…");
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(path.join(OUT, f));

const files = {};
const write = (name, svg) => {
  writeFileSync(path.join(OUT, name), svg);
  files[name] = createHash("sha1").update(svg).digest("hex").slice(0, 10);
  console.log(`  ${name.padEnd(16)} ${(svg.length / 1024).toFixed(0)} KB`);
};

write("header.svg", header(data));
config.featured.forEach((f, i) => write(`project-${i + 1}.svg`, card(f, data)));
write("open-source.svg", await openSource(data));
write("community.svg", community());
write("writing.svg", writing(posts));
config.links.forEach((l, i) => write(`link-${i + 1}.svg`, link(l)));

writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`);

/* ── README ───────────────────────────────────────────────────────────── */

const img = (name, width, alt) =>
  `<img src="./profile/generated/${name}?v=${files[name]}" width="${width}" alt="${esc(alt)}">`;
const a = (href, inner) => `<a href="${href}">${inner}</a>`;
const p = config.profile;

const cards = config.featured.map((f, i) => a(f.url, img(`project-${i + 1}.svg`, "50%", `${f.name}: ${f.description}`)));
const searchUrl = `https://github.com/pulls?q=${encodeURIComponent(`is:pr is:merged author:${USER} -user:${USER}`)}`;

const readme = `<!-- Generated by scripts/build-profile.mjs from profile.config.json. Edit those, not this file. -->

${a(p.siteUrl, img("header.svg", "100%", `${p.name}. ${p.intro}`))}

${cards[0]}${cards[1]}<br>${cards[2]}${cards[3]}

${a(searchUrl, img("open-source.svg", "100%", `${data.merged} merged pull requests to open source projects`))}

${a(`${p.siteUrl}/#community`, img("community.svg", "100%", "Community work"))}

${a(config.writing.url, img("writing.svg", "100%", "Latest writing"))}

<p align="center">${config.links.map((l, i) => a(l.url, img(`link-${i + 1}.svg`, `${100 / config.links.length}%`, l.label))).join("")}</p>
`;

writeFileSync(at("README.md"), readme);
console.log("Wrote README.md");
