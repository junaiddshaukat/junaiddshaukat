#!/usr/bin/env node
// Rebuilds everything on the profile that is a number: the header and stats
// cards in assets/, plus the open-source table and inline stats in README.md.
// .github/workflows/refresh.yml runs it once a day.
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/refresh.mjs

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER = "junaiddshaukat";
const NPM_PACKAGES = ["@isdisposable/js", "tkntracker", "reqcraft", "revise-deps"];

// Rows in the open-source table, ordered by merged PRs at render time. Repos
// that pick up a merged PR without an entry here are listed under the table.
const PROJECTS = [
  {
    name: "Apache Beam",
    owner: "apache",
    repos: ["apache/beam"],
    note: "GSoC 2026. Wrote the portable Kafka Streams runner: Beam pipeline protos in, Kafka Streams topologies out, on the Fn API so pipelines from any Beam SDK run on it. Ships in the nightly snapshots.",
  },
  {
    name: "InsForge",
    owner: "InsForge",
    repos: ["InsForge/InsForge", "InsForge/InsForge-sdk-js", "InsForge/insforge-swift", "InsForge/insforge-kotlin"],
    note: "Custom OAuth providers end to end, then carried into the JS, Swift and Kotlin SDKs. Signup controls, PostgREST operators for Kotlin, dashboard fixes.",
  },
  {
    name: "Archestra",
    owner: "archestra-ai",
    repos: ["archestra-ai/archestra"],
    note: "Enterprise MCP gateway. Added the Mistral, Cerebras, DeepSeek and Perplexity providers, and fixed Kubernetes service names for long MCP server names.",
  },
  {
    name: "Talawa Admin",
    owner: "PalisadoesFoundation",
    repos: ["PalisadoesFoundation/talawa-admin"],
    note: "Built the i18n notification toast and moved the app onto it. Turned on advanced tree-shaking in Vite; the bundle got 30% smaller.",
  },
  {
    name: "Dev Weekends",
    owner: "devweekends",
    repos: ["devweekends/web-platform"],
    note: "The community platform. Careers, projects and testimonials pages, a security cleanup, and a self-hosted links page.",
  },
  {
    name: "Apache Airflow",
    owner: "apache",
    repos: ["apache/airflow"],
    note: "Fixed user creation in the FAB auth manager when no role is given. E2E tests for Asset Details.",
  },
  {
    name: "voiceyBill",
    owner: "voiceyBill",
    repos: ["voiceyBill/voiceyBill-App", "voiceyBill/voiceyBill-web"],
    note: "UI and auth overhauls across the mobile app and the web client.",
  },
  {
    name: "Gemini CLI",
    owner: "google-gemini",
    repos: ["google-gemini/gemini-cli"],
    note: "Custom base URLs through env vars, and stricter audio MIME validation in file reads.",
  },
  {
    name: "webpack",
    owner: "webpack",
    repos: ["webpack/webpack"],
    note: "Merged the propertyAccess and propertyName utils into one module. Config coverage for Electron targets.",
  },
  {
    name: "Cognee",
    owner: "topoteretes",
    repos: ["topoteretes/cognee"],
    note: "An incremental Gmail connector for the agent memory layer. Also won their PR hackathon.",
  },
  {
    name: "Jaeger",
    owner: "jaegertracing",
    repos: ["jaegertracing/jaeger"],
    note: "Timer duration bucket parsing in the metrics init.",
  },
];

// Work that never shows up as a merged PR on GitHub.
const EXTRA_ROWS = [
  {
    name: "Kubernetes",
    href: "https://github.com/kubernetes/sig-release",
    img: "https://github.com/kubernetes.png?size=64",
    count: "release team",
    note: "Release Signal Shadow for v1.37. Tracked CI signal, flaky tests and release blockers across SIGs.",
  },
  {
    name: "Linux kernel",
    href: "https://www.kernel.org",
    img: "./assets/logos/linux.png",
    count: "patches",
    note: "Built and booted mainline on ARM64, then sent patches the old way, with git format-patch and git send-email.",
  },
];

/* ── Data ─────────────────────────────────────────────────────────────── */

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER, Accept: "application/json", ...headers },
  });
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

/** Merged PRs into repositories the user does not own, counted per repo. */
async function mergedPullRequests() {
  const q = encodeURIComponent(`is:pr is:merged author:${USER} -user:${USER}`);
  const counts = new Map();
  let seen = 0;

  for (let page = 1; page <= 10; page++) {
    const { total_count, items } = await github(
      `/search/issues?q=${q}&per_page=100&page=${page}`
    );
    for (const item of items) {
      const repo = item.repository_url.split("/repos/")[1];
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
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
    const { downloads } = await getJson(
      `https://api.npmjs.org/downloads/point/${isoDate(from)}:${isoDate(to)}/${pkg}`
    );
    if (typeof downloads !== "number") throw new Error(`No download count for ${pkg}`);
    total += downloads;
  }

  return total;
}

/* ── Formatting ───────────────────────────────────────────────────────── */

const compact = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n) => `${+n.toFixed(3)}%`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const today = () => {
  const d = new Date();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// Same tokens as junaidshaukat.com, so the profile and the site read as one thing.
const THEMES = {
  light: {
    bg: "#ffffff",
    surface: "#f9f6f3",
    fg: "#08090a",
    muted: "#474b52",
    subtle: "#6b6f76",
    border: "rgba(8,9,10,0.1)",
    accent: "#0a7c54",
    dot: "rgba(8,9,10,0.16)",
  },
  dark: {
    bg: "#08090a",
    surface: "#131416",
    fg: "#f2f3f4",
    muted: "#a1a5ac",
    subtle: "#8a8e96",
    border: "rgba(255,255,255,0.11)",
    accent: "#47b990",
    dot: "rgba(255,255,255,0.13)",
  },
};

// SVGs in a README load as images, so they cannot fetch web fonts. System stacks only.
const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`;

const sharedCss = `
  .sans { font-family: ${SANS}; }
  .mono { font-family: ${MONO}; }
  .rise { animation: rise 0.9s cubic-bezier(0.23, 1, 0.32, 1) both; }
  .ping { animation: ping 2.2s cubic-bezier(0, 0, 0.2, 1) infinite; transform-box: fill-box; transform-origin: center; }
  .blink { animation: blink 1.05s step-end infinite; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes ping { 0% { opacity: 0.7; transform: scale(1); } 100% { opacity: 0; transform: scale(3.2); } }
  @keyframes blink { 50% { opacity: 0; } }`;

const reducedMotion = (extra = "") => `
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
    .ping { opacity: 0; }${extra}
  }`;

function liveDot(t, x, y) {
  return `<circle class="ping" cx="${x}" cy="${y}" r="3.5" fill="${t.accent}"/><circle cx="${x}" cy="${y}" r="3.5" fill="${t.accent}"/>`;
}

/* ── Header card ──────────────────────────────────────────────────────── */

function renderHeader(t, stats, avatar) {
  const W = 1200;
  const H = 410;
  const CH = 12; // advance of a 20px monospace glyph; textLength pins every font to it

  const lines = [
    "wrote Apache Beam's Kafka Streams runner for GSoC '26",
    `got ${stats.merged} PRs merged into projects I don't own`,
    "shipped blyn, an AI money coach, to the App Store",
    "built Divisio: every coding agent in one window",
    "started Qwen Pakistan from an empty page",
    "ran the first RevenueCat Shipaton in Pakistan",
  ];

  const box = { x: 64, y: 248, w: 760, h: 58 };
  const textX = 112;
  const baseline = box.y + 36;
  const seconds = lines.length * 4;
  const slot = 100 / lines.length;

  let typingCss = "";
  let typing = "";

  lines.forEach((line, i) => {
    const width = line.length * CH;
    const start = i * slot;
    const typed = start + slot * 0.45;
    const hide = start + slot * 0.94;

    // Each line owns one slot of the loop: typed out a character per step,
    // held, then swapped for the next. A cover the colour of the terminal
    // slides off the text, and the cursor rides its leading edge.
    const visible = [
      start > 0 && `0%, ${pct(start)} { opacity: 0; }`,
      `${pct(start + 0.001)}, ${pct(hide)} { opacity: 1; }`,
      `${pct(hide + 0.001)}, 100% { opacity: 0; }`,
    ];
    const reveal = [
      start > 0 && `0% { transform: translateX(0px); animation-timing-function: step-end; }`,
      `${pct(start)} { transform: translateX(0px); animation-timing-function: steps(${line.length}, end); }`,
      `${pct(typed)} { transform: translateX(${width}px); animation-timing-function: step-end; }`,
      `100% { transform: translateX(${width}px); }`,
    ];

    typingCss += `
  .line${i} { opacity: ${i === 0 ? 1 : 0}; animation: line${i} ${seconds}s linear infinite; }
  .reveal${i} { transform: translateX(${i === 0 ? width : 0}px); animation: reveal${i} ${seconds}s linear infinite; }
  @keyframes line${i} { ${visible.filter(Boolean).join(" ")} }
  @keyframes reveal${i} { ${reveal.filter(Boolean).join(" ")} }`;

    typing += `
      <g class="line${i}">
        <text x="${textX}" y="${baseline}" class="mono" font-size="20" fill="${t.fg}" textLength="${width}" lengthAdjust="spacingAndGlyphs">${esc(line)}</text>
        <g class="reveal${i}">
          <rect x="${textX}" y="${box.y + 6}" width="${box.w}" height="${box.h - 12}" fill="${t.surface}"/>
          <rect class="blink" x="${textX + 1}" y="${baseline - 18}" width="10" height="23" rx="1.5" fill="${t.accent}"/>
        </g>
      </g>`;
  });

  const chipLabels = [
    "GSoC '26 · Apache Beam",
    "Kubernetes v1.37 Release Team",
    "Qwen Ambassador",
    `${stats.merged} PRs merged upstream`,
  ];
  let chipX = 64;
  const chips = chipLabels
    .map((label) => {
      const textWidth = label.length * 7.2;
      const w = textWidth + 40;
      const chip = `
      <g>
        <rect x="${chipX}" y="336" width="${w}" height="30" rx="15" fill="${t.surface}" stroke="${t.border}"/>
        <circle cx="${chipX + 16}" cy="351" r="3" fill="${t.accent}"/>
        <text x="${chipX + 27}" y="355.5" class="mono" font-size="12" fill="${t.muted}" textLength="${textWidth}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>
      </g>`;
      chipX += w + 10;
      return chip;
    })
    .join("");

  const av = { cx: 1030, cy: 208, r: 104 };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
  <title id="title">Muhammad Junaid Shaukat. I build software people use. Most of it is open source.</title>
  <style>${sharedCss}${typingCss}
  .orbit { transform-origin: ${av.cx}px ${av.cy}px; animation: spin 9s linear infinite; }
  .orbit-slow { transform-origin: ${av.cx}px ${av.cy}px; animation: spin 60s linear infinite reverse; }
  @keyframes spin { to { transform: rotate(360deg); } }${reducedMotion()}
  </style>
  <defs>
    <clipPath id="card"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16"/></clipPath>
    <clipPath id="terminal"><rect x="${textX - 2}" y="${box.y + 1}" width="${box.x + box.w - textX - 10}" height="${box.h - 2}"/></clipPath>
    <clipPath id="avatar"><circle cx="${av.cx}" cy="${av.cy}" r="${av.r}"/></clipPath>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${t.dot}"/></pattern>
    <radialGradient id="fade" cx="0.85" cy="0.42" r="0.6"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
    <mask id="dotmask"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    <radialGradient id="glow"><stop offset="0" stop-color="${t.accent}" stop-opacity="0.26"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>
  </defs>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${t.bg}" stroke="${t.border}"/>
  <g clip-path="url(#card)">
    <rect y="53" width="${W}" height="${H - 53}" fill="url(#dots)" mask="url(#dotmask)"/>
    <circle cx="${av.cx}" cy="${av.cy}" r="220" fill="url(#glow)"/>
  </g>

  <circle cx="30" cy="27" r="6" fill="#ff5f57"/>
  <circle cx="50" cy="27" r="6" fill="#febc2e"/>
  <circle cx="70" cy="27" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="31.5" text-anchor="middle" class="mono" font-size="13" fill="${t.subtle}">junaid@github: ~</text>
  <line x1="0.5" x2="${W - 0.5}" y1="53.5" y2="53.5" stroke="${t.border}"/>

  <g class="rise" style="animation-delay: 0.05s">
    ${liveDot(t, 70, 105)}
    <text x="84" y="109.5" class="mono" font-size="13" letter-spacing="2" fill="${t.subtle}">AI ENGINEER · OPEN SOURCE · COMMUNITY</text>
  </g>

  <g class="rise" style="animation-delay: 0.15s">
    <text x="62" y="176" class="sans" font-size="58" font-weight="700" letter-spacing="-1.6" fill="${t.fg}">Muhammad Junaid Shaukat</text>
  </g>

  <g class="rise" style="animation-delay: 0.25s">
    <text x="64" y="219" class="sans" font-size="22" fill="${t.muted}">I build software people use. Most of it is open source.</text>
  </g>

  <g class="rise" style="animation-delay: 0.35s">
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="10" fill="${t.surface}" stroke="${t.border}"/>
    <path d="M86 ${baseline - 14} l8 7.5 -8 7.5" fill="none" stroke="${t.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <g clip-path="url(#terminal)">${typing}
    </g>
  </g>

  <g class="rise" style="animation-delay: 0.45s">${chips}
  </g>

  <g class="rise" style="animation-delay: 0.2s">
    <circle class="orbit-slow" cx="${av.cx}" cy="${av.cy}" r="${av.r + 24}" fill="none" stroke="${t.border}" stroke-width="1.5" stroke-dasharray="2 8" stroke-linecap="round"/>
    <circle class="orbit" cx="${av.cx}" cy="${av.cy}" r="${av.r + 12}" fill="none" stroke="${t.accent}" stroke-width="2.5" stroke-dasharray="70 660" stroke-linecap="round"/>
    <image href="data:image/jpeg;base64,${avatar}" x="${av.cx - av.r}" y="${av.cy - av.r}" width="${av.r * 2}" height="${av.r * 2}" clip-path="url(#avatar)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${av.cx}" cy="${av.cy}" r="${av.r}" fill="none" stroke="${t.border}"/>
    <text x="${av.cx}" y="${av.cy + av.r + 70}" text-anchor="middle" class="mono" font-size="12" letter-spacing="1" fill="${t.subtle}">based in Pakistan</text>
  </g>
</svg>
`;
}

/* ── Stats card ───────────────────────────────────────────────────────── */

function renderStats(t, stats, date) {
  const W = 1200;
  const H = 206;
  const pad = 40;
  const cellW = (W - pad * 2) / 4;

  const cells = [
    { value: stats.merged, label: "PRs merged upstream", sub: `across ${stats.repos} repositories` },
    { value: stats.beam, label: "of them into Apache Beam", sub: "GSoC '26 · Kafka Streams runner" },
    { value: stats.orgs, label: "open-source orgs", sub: "Apache, InsForge, webpack…" },
    { value: compact(stats.npmTotal), label: "npm downloads", sub: `across ${NPM_PACKAGES.length} packages` },
  ];

  const body = cells
    .map((cell, i) => {
      const x = pad + i * cellW + (i === 0 ? 0 : 28);
      const divider =
        i === 0 ? "" : `<line x1="${pad + i * cellW}" x2="${pad + i * cellW}" y1="84" y2="178" stroke="${t.border}"/>`;
      return `
  ${divider}
  <g class="rise" style="animation-delay: ${0.1 + i * 0.08}s">
    <text x="${x}" y="128" class="sans" font-size="52" font-weight="700" letter-spacing="-1.5" fill="${t.fg}">${esc(cell.value)}</text>
    <text x="${x}" y="154" class="sans" font-size="16" fill="${t.muted}">${esc(cell.label)}</text>
    <text x="${x}" y="177" class="mono" font-size="12" fill="${t.subtle}">${esc(cell.sub)}</text>
  </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title" data-refreshed="${date}">
  <title id="title">${stats.merged} PRs merged upstream across ${stats.repos} repositories, ${stats.beam} into Apache Beam, ${stats.orgs} open-source orgs, ${compact(stats.npmTotal)} npm downloads.</title>
  <style>${sharedCss}${reducedMotion()}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="16" fill="${t.bg}" stroke="${t.border}"/>
  ${liveDot(t, pad + 4, 32)}
  <text x="${pad + 18}" y="36.5" class="mono" font-size="12" letter-spacing="1.5" fill="${t.subtle}">LIVE FROM THE GITHUB AND NPM APIS</text>
  <text x="${W - pad}" y="36.5" text-anchor="end" class="mono" font-size="12" fill="${t.subtle}">refreshed ${esc(date)}</text>
  <line x1="0.5" x2="${W - 0.5}" y1="56.5" y2="56.5" stroke="${t.border}"/>${body}
</svg>
`;
}

/* ── README ───────────────────────────────────────────────────────────── */

function prSearchUrl(repos) {
  const q = `is:pr is:merged author:${USER} ${repos.map((r) => `repo:${r}`).join(" ")}`;
  return `https://github.com/search?type=pullrequests&q=${encodeURIComponent(q)}`;
}

// Returns two cells, logo and name. GitHub's auto table layout collapses a
// column that holds only images, so the table header gives it width with &nbsp;.
const projectCell = (img, name, href) =>
  `<img src="${img}" width="20" height="20" alt=""> | <a href="${href}"><b>${name.replaceAll(" ", "&nbsp;")}</b></a>`;

function renderOssTable(counts) {
  const countFor = (repos) => repos.reduce((sum, r) => sum + (counts.get(r.toLowerCase())?.n ?? 0), 0);

  const rows = PROJECTS.map((p, i) => ({ ...p, i, merged: countFor(p.repos) }))
    .filter((p) => p.merged > 0)
    .sort((a, b) => b.merged - a.merged || a.i - b.i)
    .map((p) => {
      const cell = projectCell(`https://github.com/${p.owner}.png?size=64`, p.name, `https://github.com/${p.repos[0]}`);
      return `| ${cell} | [${p.merged}](${prSearchUrl(p.repos)}) | ${p.note} |`;
    });

  const extra = EXTRA_ROWS.map((r) => `| ${projectCell(r.img, r.name, r.href)} | ${r.count.replaceAll(" ", "&nbsp;")} | ${r.note} |`);

  const known = new Set(PROJECTS.flatMap((p) => p.repos.map((r) => r.toLowerCase())));
  const others = [...counts.values()].filter((c) => !known.has(c.repo.toLowerCase()));
  const otherLine = others.length
    ? `\n\n<sub>Plus ${others.reduce((s, c) => s + c.n, 0)} more in ${others
        .map((c) => `[${c.repo}](https://github.com/${c.repo})`)
        .join(", ")}.</sub>`
    : "";

  return [
    `| ${"&nbsp;".repeat(6)} | Project | Merged | What I did |`,
    "| :-: | :-- | :-: | :-- |",
    ...rows,
    ...extra,
  ].join("\n") + otherLine;
}

function renderReadme(src, stats, counts) {
  const values = {
    merged: stats.merged,
    repos: stats.repos,
    orgs: stats.orgs,
    beam: stats.beam,
    insforge: stats.insforge,
    npm_total: compact(stats.npmTotal),
    isdisposable_npm: compact(stats.downloads["@isdisposable/js"]),
    tkntracker_npm: compact(stats.downloads.tkntracker),
  };

  return src
    .replace(/<!--stat:(\w+)-->.*?<!--\/stat-->/g, (_, key) => {
      if (!(key in values)) throw new Error(`README.md asks for an unknown stat "${key}"`);
      return `<!--stat:${key}-->${values[key]}<!--/stat-->`;
    })
    .replace(
      /<!--oss:start-->[\s\S]*?<!--oss:end-->/,
      `<!--oss:start-->\n\n${renderOssTable(counts)}\n\n<!--oss:end-->`
    );
}

/* ── Main ─────────────────────────────────────────────────────────────── */

/**
 * Writes a file only when its content changed. A card whose numbers are the
 * same keeps its old "refreshed" date, so quiet days make no commit.
 */
async function update(file, render) {
  const full = path.join(ROOT, file);
  const prev = await readFile(full, "utf8").catch(() => "");
  const prevDate = prev.match(/data-refreshed="([^"]+)"/)?.[1];
  if (prevDate && render(prevDate, prev) === prev) return;

  const next = render(today(), prev);
  if (next === prev) return;
  await writeFile(full, next);
  console.log(`updated ${file}`);
}

const byRepo = await mergedPullRequests();
const counts = new Map([...byRepo].map(([repo, n]) => [repo.toLowerCase(), { repo, n }]));
const downloads = Object.fromEntries(
  await Promise.all(NPM_PACKAGES.map(async (pkg) => [pkg, await npmDownloads(pkg)]))
);
const sumFor = (repos) => repos.reduce((sum, r) => sum + (counts.get(r.toLowerCase())?.n ?? 0), 0);

const stats = {
  merged: [...byRepo.values()].reduce((a, b) => a + b, 0),
  repos: byRepo.size,
  orgs: new Set([...counts.keys()].map((r) => r.split("/")[0])).size,
  beam: sumFor(["apache/beam"]),
  insforge: sumFor(PROJECTS.find((p) => p.name === "InsForge").repos),
  npmTotal: Object.values(downloads).reduce((a, b) => a + b, 0),
  downloads,
};
console.log(stats);

const avatar = (await readFile(path.join(ROOT, "assets/avatar.jpg"))).toString("base64");

for (const [name, theme] of Object.entries(THEMES)) {
  await update(`assets/header-${name}.svg`, () => renderHeader(theme, stats, avatar));
  await update(`assets/stats-${name}.svg`, (date) => renderStats(theme, stats, date));
}
await update("README.md", (_, prev) => renderReadme(prev, stats, counts));
