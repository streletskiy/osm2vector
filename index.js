const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
require('dotenv').config();

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOverpassServers() {
  const fromEnv = (process.env.OVERPASS_URLS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (fromEnv.length > 0) {
    return fromEnv;
  }

  return [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
}

const DEFAULT_BBOX = {
  south: envNumber('FULL_BBOX_SOUTH', 56.1197),
  west: envNumber('FULL_BBOX_WEST', 43.65),
  north: envNumber('FULL_BBOX_NORTH', 56.4803),
  east: envNumber('FULL_BBOX_EAST', 44.30)
};

const TEST_BBOX = {
  south: envNumber('TEST_BBOX_SOUTH', 56.3134),
  west: envNumber('TEST_BBOX_WEST', 43.965),
  north: envNumber('TEST_BBOX_NORTH', 56.3466),
  east: envNumber('TEST_BBOX_EAST', 44.025)
};

const CITY_NAME = process.env.CITY_NAME || 'city';
const DEFAULT_STYLE_NAME = 'default';
const RENDERER_HTML_PATH = path.resolve(__dirname, 'renderer.html');
const PUPPETEER_PROFILE_DIR = path.resolve(__dirname, '.puppeteer-profile');
const CACHE_DB_PATH = path.resolve(
  __dirname,
  process.env.OVERPASS_CACHE_DB_PATH || 'db/overpass_cache.sqlite'
);

let cacheDb = null;
process.on('exit', () => {
  try {
    if (cacheDb) cacheDb.close();
  } catch {
    // noop
  }
});

function parseCliArgs(argv) {
  let isTestMode = false;
  let forceRefresh = false;
  let bbox = null;
  let outputBase = null;
  let styleName = DEFAULT_STYLE_NAME;
  let cityName = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const lower = arg.toLowerCase();

    if (lower === 'test' || lower === '--mode=test') {
      isTestMode = true;
      continue;
    }
    if (lower === '--mode=full') {
      isTestMode = false;
      continue;
    }
    if (lower === '--mode') {
      const next = String(argv[i + 1] || '').toLowerCase();
      if (next !== 'test' && next !== 'full') {
        throw new Error('--mode must be "test" or "full".');
      }
      isTestMode = next === 'test';
      i += 1;
      continue;
    }
    if (['--refresh', 'refresh', '-r'].includes(lower)) {
      forceRefresh = true;
      continue;
    }
    if (lower.startsWith('--bbox=')) {
      bbox = parseBboxArg(arg.slice('--bbox='.length));
      continue;
    }
    if (lower === '--bbox') {
      const next = argv[i + 1];
      if (!next) throw new Error('--bbox requires value: "south,west,north,east".');
      bbox = parseBboxArg(next);
      i += 1;
      continue;
    }
    if (lower.startsWith('--output=')) {
      outputBase = normalizeOutputBase(arg.slice('--output='.length));
      continue;
    }
    if (lower === '--output') {
      const next = argv[i + 1];
      if (!next) throw new Error('--output requires value.');
      outputBase = normalizeOutputBase(next);
      i += 1;
      continue;
    }
    if (lower.startsWith('--name=')) {
      cityName = normalizeCityName(arg.slice('--name='.length));
      continue;
    }
    if (lower === '--name') {
      const next = argv[i + 1];
      if (!next) throw new Error('--name requires value.');
      cityName = normalizeCityName(next);
      i += 1;
      continue;
    }
    if (lower.startsWith('--style=')) {
      styleName = normalizeStyleName(arg.slice('--style='.length));
      continue;
    }
    if (lower === '--style') {
      const next = argv[i + 1];
      if (!next) throw new Error('--style requires value.');
      styleName = normalizeStyleName(next);
      i += 1;
      continue;
    }
  }

  return { isTestMode, forceRefresh, bbox, outputBase, styleName, cityName };
}

function parseBboxArg(raw) {
  const parts = String(raw)
    .split(',')
    .map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x))) {
    throw new Error('Invalid --bbox. Expected format: "south,west,north,east".');
  }
  return {
    south: parts[0],
    west: parts[1],
    north: parts[2],
    east: parts[3]
  };
}

function normalizeOutputBase(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('Invalid --output: empty value.');
  }
  return trimmed.replace(/\.(svg|pdf)$/i, '');
}

function normalizeStyleName(raw) {
  const trimmed = String(raw || '').trim().toLowerCase();
  if (!trimmed) throw new Error('Invalid --style: empty value.');
  return trimmed.replace(/\.js$/i, '');
}

function normalizeCityName(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('Invalid --name: empty value.');
  return trimmed;
}

function sanitizeToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function dateStampDdMmYyyy(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

function resolveStyleName(requestedStyleName) {
  const normalized = normalizeStyleName(requestedStyleName || DEFAULT_STYLE_NAME);
  const stylePath = path.resolve(__dirname, 'styles', `${normalized}.js`);
  if (fs.existsSync(stylePath)) return normalized;
  console.warn(`Style "${normalized}" not found. Falling back to "${DEFAULT_STYLE_NAME}".`);
  return DEFAULT_STYLE_NAME;
}

function buildDefaultOutputBase({ isTestMode, styleName, cityName }) {
  const cityToken = sanitizeToken(cityName) || 'city';
  const styleToken = sanitizeToken(styleName) || DEFAULT_STYLE_NAME;
  const modeToken = isTestMode ? '_test' : '';
  return path.join('outputs', `${cityToken}_${styleToken}${modeToken}_${dateStampDdMmYyyy()}`);
}

function resolveOutputPaths(outputBase) {
  const normalized = normalizeOutputBase(outputBase);
  const basePath = path.isAbsolute(normalized) ? normalized : path.resolve(__dirname, normalized);
  return {
    svg: `${basePath}.svg`,
    pdf: `${basePath}.pdf`
  };
}

function getCacheDb() {
  if (cacheDb) return cacheDb;

  fs.mkdirSync(path.dirname(CACHE_DB_PATH), { recursive: true });
  cacheDb = new Database(CACHE_DB_PATH);
  cacheDb.pragma('journal_mode = WAL');
  cacheDb.pragma('synchronous = NORMAL');
  cacheDb.exec(`
    CREATE TABLE IF NOT EXISTS overpass_cache (
      cache_key TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      bbox_south REAL NOT NULL,
      bbox_west REAL NOT NULL,
      bbox_north REAL NOT NULL,
      bbox_east REAL NOT NULL,
      query_hash TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
  `);
  cacheDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_overpass_cache_fetched_at
    ON overpass_cache(fetched_at);
  `);
  return cacheDb;
}

function getCacheKey(bbox, mode, query) {
  const bboxToken = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  const queryHash = crypto.createHash('sha1').update(query).digest('hex');
  return `${mode}|${bboxToken}|${queryHash}`;
}

function readOverpassCache(cacheKey, ttlMs) {
  const db = getCacheDb();
  const row = db
    .prepare('SELECT fetched_at, data_json FROM overpass_cache WHERE cache_key = ?')
    .get(cacheKey);
  if (!row) {
    return { hit: false, stale: false, data: null };
  }

  const ageMs = Date.now() - Number(row.fetched_at || 0);
  if (ttlMs > 0 && ageMs > ttlMs) {
    return { hit: false, stale: true, data: null, ageMs };
  }

  try {
    const parsed = JSON.parse(row.data_json);
    if (!parsed || !Array.isArray(parsed.elements)) {
      return { hit: false, stale: true, data: null };
    }
    return { hit: true, stale: false, data: parsed, ageMs };
  } catch {
    return { hit: false, stale: true, data: null };
  }
}

function writeOverpassCache(cacheKey, bbox, mode, query, data) {
  const db = getCacheDb();
  const queryHash = crypto.createHash('sha1').update(query).digest('hex');
  db.prepare(
    `
    INSERT INTO overpass_cache (
      cache_key, mode, bbox_south, bbox_west, bbox_north, bbox_east,
      query_hash, fetched_at, data_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      mode=excluded.mode,
      bbox_south=excluded.bbox_south,
      bbox_west=excluded.bbox_west,
      bbox_north=excluded.bbox_north,
      bbox_east=excluded.bbox_east,
      query_hash=excluded.query_hash,
      fetched_at=excluded.fetched_at,
      data_json=excluded.data_json
  `
  ).run(
    cacheKey,
    mode,
    bbox.south,
    bbox.west,
    bbox.north,
    bbox.east,
    queryHash,
    Date.now(),
    JSON.stringify(data)
  );
}

function resolveBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  try {
    const bundledPath = puppeteer.executablePath();
    if (bundledPath && fs.existsSync(bundledPath)) {
      return bundledPath;
    }
  } catch {
    // Ignore and fall through.
  }

  return null;
}

function getPuppeteerLaunchOptions(executablePath) {
  return {
    headless: true,
    executablePath,
    protocolTimeout: 600000,
    userDataDir: PUPPETEER_PROFILE_DIR,
    args: ['--allow-file-access-from-files', '--disable-crashpad', '--disable-breakpad']
  };
}

function getCanvasSizeCandidates() {
  const base = Math.max(1000, Math.floor(envNumber('RENDER_CANVAS_SIZE', 2000)));
  return [base];
}

function isTargetClosedError(error) {
  const message = String((error && error.message) || error || '');
  return (
    message.includes('Target closed') ||
    message.includes('Session closed') ||
    message.includes('TargetCloseError') ||
    message.includes('Runtime.callFunctionOn')
  );
}

async function safeCloseBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (error) {
    const message = String((error && error.message) || error || '');
    const isBusy = error && error.code === 'EBUSY';
    const isCrashpadLock = message.includes('CrashpadMetrics-active.pma');
    if (!(isBusy || isCrashpadLock)) {
      throw error;
    }
    console.warn('Ignoring Windows EBUSY while cleaning Chrome crashpad temp files.');
  }
}

function buildOverpassQuery(bbox, mode = 'all') {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  let body = '';

  if (mode === 'buildings' || mode === 'all') {
    body += `
  way["building"](${bboxStr});
  relation["building"](${bboxStr});
`;
  }

  if (mode === 'areas' || mode === 'all') {
    body += `
  way["area:highway"~"^(footway|pedestrian)$"](${bboxStr});
  relation["area:highway"~"^(footway|pedestrian)$"](${bboxStr});

  way["landuse"="grass"](${bboxStr});
  relation["landuse"="grass"](${bboxStr});

  way["natural"="water"](${bboxStr});
  relation["natural"="water"](${bboxStr});

  way["leisure"="park"](${bboxStr});
  relation["leisure"="park"](${bboxStr});
`;
  }

  if (mode === 'lines' || mode === 'all') {
    body += `
  way["highway"](${bboxStr});
  relation["highway"](${bboxStr});
  way["railway"](${bboxStr});
  relation["railway"](${bboxStr});
`;
  }

  return `
[out:json][timeout:180];
(
${body}
);
out geom;
`;
}

/**
 * Fetch OSM data from Overpass.
 * Uses out geom so lunar_assembler can work directly with coordinates.
 */
async function fetchOverpassData(bbox, mode = 'all', options = {}) {
  const refresh = Boolean(options.refresh);
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : 0;
  const query = buildOverpassQuery(bbox, mode);
  const cacheKey = getCacheKey(bbox, mode, query);

  if (!refresh) {
    const cached = readOverpassCache(cacheKey, ttlMs);
    if (cached.hit) {
      const ageMins = cached.ageMs != null ? Math.round(cached.ageMs / 60000) : 0;
      console.log(`Overpass cache hit: mode=${mode}, age=${ageMins}m`);
      return cached.data;
    }
    if (cached.stale) {
      console.log(`Overpass cache stale: mode=${mode}, refreshing...`);
    } else {
      console.log(`Overpass cache miss: mode=${mode}`);
    }
  } else {
    console.log(`Overpass cache bypassed (--refresh): mode=${mode}`);
  }

  const servers = getOverpassServers();
  const errors = [];
  const maxAttemptsPerServer = 2;

  for (const serverUrl of servers) {
    for (let attempt = 1; attempt <= maxAttemptsPerServer; attempt += 1) {
      try {
        console.log(
          `Overpass request: server=${serverUrl}, attempt=${attempt}/${maxAttemptsPerServer}`
        );
        const response = await axios.post(serverUrl, query, {
          headers: { 'Content-Type': 'text/plain' },
          timeout: 240000
        });

        if (!response.data || !Array.isArray(response.data.elements)) {
          throw new Error('Unexpected Overpass response format.');
        }

        writeOverpassCache(cacheKey, bbox, mode, query, response.data);
        return response.data;
      } catch (error) {
        const status = error && error.response ? error.response.status : null;
        const message = error && error.message ? error.message : String(error);
        errors.push(`${serverUrl} [attempt ${attempt}] -> ${status || 'n/a'} ${message}`);

        const retryable =
          status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

        // Retry same server only for transient HTTP failures.
        if (retryable && attempt < maxAttemptsPerServer) {
          await sleep(2000 * attempt);
          continue;
        }

        // Move to next server for non-retryable errors or after retries exhausted.
        break;
      }
    }
  }

  throw new Error(`Failed to fetch Overpass data after trying all servers.\n${errors.join('\n')}`);
}

function splitOverpassDataForThreePasses(overpassData) {
  const elements = Array.isArray(overpassData && overpassData.elements) ? overpassData.elements : [];
  const areaElements = [];
  const buildingElements = [];
  const lineElements = [];

  for (const element of elements) {
    const tags = (element && element.tags) || {};
    const areaHighway = tags['area:highway'];
    const isAreaPass =
      areaHighway === 'footway' ||
      areaHighway === 'pedestrian' ||
      tags.landuse === 'grass' ||
      tags.natural === 'water' ||
      tags.leisure === 'park';
    const isBuildingPass = Boolean(tags.building);
    const isLinePass = Boolean((tags.highway && tags.highway !== 'construction') || tags.railway);

    // Priority to avoid duplicate rendering of the same feature in multiple passes.
    if (isAreaPass) {
      areaElements.push(element);
    } else if (isBuildingPass) {
      buildingElements.push(element);
    } else if (isLinePass) {
      lineElements.push(element);
    }
  }

  return {
    areaData: { ...overpassData, elements: areaElements },
    buildingData: { ...overpassData, elements: buildingElements },
    lineData: { ...overpassData, elements: lineElements }
  };
}

async function renderSvgWithPuppeteer(overpassData, bbox, styleName) {
  if (!fs.existsSync(RENDERER_HTML_PATH)) {
    throw new Error(`renderer.html not found at ${RENDERER_HTML_PATH}`);
  }

  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to a browser binary path.'
    );
  }

  const canvasCandidates = getCanvasSizeCandidates();
  const renderAttempts = Math.max(1, Math.floor(envNumber('RENDER_ATTEMPTS', 3)));
  const errors = [];

  for (const canvasSize of canvasCandidates) {
    for (let attempt = 1; attempt <= renderAttempts; attempt += 1) {
    let browser = null;
    try {
      console.log(
          `Render attempt ${attempt}/${renderAttempts} with canvas ${canvasSize}x${canvasSize}`
      );
      fs.mkdirSync(PUPPETEER_PROFILE_DIR, { recursive: true });
      browser = await puppeteer.launch(getPuppeteerLaunchOptions(executablePath));
      const page = await browser.newPage();
      const rendererFileUrl = `file://${RENDERER_HTML_PATH.replace(/\\/g, '/')}?style=${encodeURIComponent(styleName)}`;
      await page.goto(rendererFileUrl, { waitUntil: 'load' });

      const svgOuterHtml = await page.evaluate(
        async ({ data, bboxForRender, canvas }) => {
          if (typeof window.renderWithLunarAssembler !== 'function') {
            throw new Error(
              'window.renderWithLunarAssembler is not available. Check renderer.html script includes.'
            );
          }

          const svg = await window.renderWithLunarAssembler(data, bboxForRender, {
            canvasWidth: canvas.width,
            canvasHeight: canvas.height
          });
          if (!svg || typeof svg !== 'string') {
            throw new Error('Lunar assembler render returned empty SVG output.');
          }
          return svg;
        },
        {
          data: overpassData,
          bboxForRender: bbox,
          canvas: { width: canvasSize, height: canvasSize }
        }
      );

      return svgOuterHtml;
    } catch (error) {
        errors.push(`canvas=${canvasSize}, attempt=${attempt}: ${error.message || String(error)}`);
        if (!isTargetClosedError(error) || attempt === renderAttempts) {
          throw new Error(`SVG render failed.\n${errors.join('\n')}`);
        }
        console.warn(
          `Renderer target closed on canvas ${canvasSize}. Retrying with the same canvas...`
        );
        await sleep(1000 * attempt);
      } finally {
        await safeCloseBrowser(browser);
      }
    }
  }

  throw new Error(`SVG render failed.\n${errors.join('\n')}`);
}

async function mergeTwoSvgHtmlWithPuppeteer(bottomSvg, topSvg) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to a browser binary path.'
    );
  }

  fs.mkdirSync(PUPPETEER_PROFILE_DIR, { recursive: true });
  const browser = await puppeteer.launch(getPuppeteerLaunchOptions(executablePath));
  try {
    const page = await browser.newPage();
    const merged = await page.evaluate(
      ({ bottomSvgHtml, topSvgHtml }) => {
        const parser = new DOMParser();
        const baseDoc = parser.parseFromString(bottomSvgHtml, 'image/svg+xml');
        const lineDoc = parser.parseFromString(topSvgHtml, 'image/svg+xml');

        const baseRoot = baseDoc.documentElement;
        const lineRoot = lineDoc.documentElement;
        if (!baseRoot || !lineRoot) {
          throw new Error('Failed to parse SVG during merge.');
        }

        const mergedRoot = baseRoot.cloneNode(true);
        const lineChildren = Array.from(lineRoot.childNodes);
        for (const node of lineChildren) {
          if (
            node.nodeType === 1 &&
            node.tagName &&
            node.tagName.toLowerCase() === 'rect' &&
            node.getAttribute &&
            node.getAttribute('data-background-fill') === 'yes'
          ) {
            continue;
          }
          mergedRoot.appendChild(node.cloneNode(true));
        }

        return mergedRoot.outerHTML;
      },
      { bottomSvgHtml: bottomSvg, topSvgHtml: topSvg }
    );
    return merged;
  } finally {
    await safeCloseBrowser(browser);
  }
}

async function renderThreePassSvgWithPuppeteer(areaData, buildingData, lineData, bbox, styleName) {
  const areaSvg = await renderSvgWithPuppeteer(areaData, bbox, styleName);
  const buildingSvg = await renderSvgWithPuppeteer(buildingData, bbox, styleName);
  const lineSvg = await renderSvgWithPuppeteer(lineData, bbox, styleName);

  const areaPlusBuildings = await mergeTwoSvgHtmlWithPuppeteer(areaSvg, buildingSvg);
  const merged = await mergeTwoSvgHtmlWithPuppeteer(areaPlusBuildings, lineSvg);
  return merged;
}

function parseSvgSize(svgContent) {
  const viewBoxMatch = svgContent.match(/viewBox="([^"]+)"/i);
  if (!viewBoxMatch) {
    return { width: 2000, height: 2000 };
  }

  const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return { width: 2000, height: 2000 };
  }

  const width = Math.max(1, Math.ceil(parts[2]));
  const height = Math.max(1, Math.ceil(parts[3]));
  return { width, height };
}

async function exportSvgToPdf(svgContent, outputPdfPath) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error(
      'No Chrome/Edge executable found. Set PUPPETEER_EXECUTABLE_PATH to a browser binary path.'
    );
  }

  const { width, height } = parseSvgSize(svgContent);
  fs.mkdirSync(PUPPETEER_PROFILE_DIR, { recursive: true });
  const browser = await puppeteer.launch(getPuppeteerLaunchOptions(executablePath));

  try {
    const page = await browser.newPage();
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: ${width}px ${height}px; margin: 0; }
      html, body { margin: 0; padding: 0; background: #ffffff; }
      svg { display: block; width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>${svgContent}</body>
</html>`;

    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputPdfPath,
      printBackground: true,
      preferCSSPageSize: true
    });
  } finally {
    await safeCloseBrowser(browser);
  }
}

async function main() {
  const { isTestMode, forceRefresh, bbox, outputBase, styleName, cityName } = parseCliArgs(
    process.argv.slice(2)
  );
  const activeStyleName = resolveStyleName(styleName);
  const activeCityName = cityName || CITY_NAME;
  const activeBbox = bbox || (isTestMode ? TEST_BBOX : DEFAULT_BBOX);
  const defaultOutputBase = buildDefaultOutputBase({
    isTestMode,
    styleName: activeStyleName,
    cityName: activeCityName
  });
  const resolvedOutputs = resolveOutputPaths(outputBase || defaultOutputBase);
  const outputSvgPath = resolvedOutputs.svg;
  const outputPdfPath = resolvedOutputs.pdf;
  const ttlHours = isTestMode
    ? envNumber('OVERPASS_CACHE_TTL_TEST_HOURS', 24)
    : envNumber('OVERPASS_CACHE_TTL_FULL_HOURS', 168);
  const ttlMs = Math.max(0, Math.floor(ttlHours * 60 * 60 * 1000));

  console.log(`Mode: ${isTestMode ? 'test' : 'full'}`);
  console.log(`City: ${activeCityName}`);
  console.log(`Style: ${activeStyleName}`);
  console.log(`BBOX: ${activeBbox.south},${activeBbox.west},${activeBbox.north},${activeBbox.east}`);
  console.log(`Output base: ${outputBase || defaultOutputBase}`);
  console.log(`Overpass cache: ttl=${ttlHours}h, refresh=${forceRefresh ? 'yes' : 'no'}`);

  console.log('Fetching OSM data from Overpass...');
  const overpassData = await fetchOverpassData(activeBbox, 'all', {
    refresh: forceRefresh,
    ttlMs
  });
  console.log(`Fetched raw data: ${overpassData.elements.length} elements.`);
  const { areaData, buildingData, lineData } = splitOverpassDataForThreePasses(overpassData);
  console.log(`Pass split -> areas: ${areaData.elements.length}, buildings: ${buildingData.elements.length}, lines: ${lineData.elements.length}`);

  console.log('Rendering SVG with Puppeteer + lunar_assembler (pass 1: areas)...');
  console.log('Rendering SVG with Puppeteer + lunar_assembler (pass 2: buildings)...');
  console.log('Rendering SVG with Puppeteer + lunar_assembler (pass 3: lines)...');
  const svg = await renderThreePassSvgWithPuppeteer(
    areaData,
    buildingData,
    lineData,
    activeBbox,
    activeStyleName
  );

  fs.mkdirSync(path.dirname(outputSvgPath), { recursive: true });
  fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
  fs.writeFileSync(outputSvgPath, svg, 'utf8');
  console.log(`SVG written to: ${outputSvgPath}`);

  console.log('Exporting PDF from SVG...');
  await exportSvgToPdf(svg, outputPdfPath);
  console.log(`PDF written to: ${outputPdfPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchOverpassData,
  renderSvgWithPuppeteer,
  renderThreePassSvgWithPuppeteer,
  exportSvgToPdf
};
