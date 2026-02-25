const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...opts
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve(0);
      reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveBrowserPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fileExists(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }

  try {
    const puppeteer = require('puppeteer');
    const bundled = puppeteer.executablePath();
    if (bundled && fileExists(bundled)) return bundled;
  } catch {}

  return null;
}

async function ensureBrowser() {
  let browserPath = resolveBrowserPath();
  if (browserPath) {
    log(`Browser found: ${browserPath}`);
    return;
  }

  log('No browser found. Trying to install Chrome via Puppeteer...');
  try {
    await run('npx', ['puppeteer', 'browsers', 'install', 'chrome']);
  } catch (error) {
    log(`Browser install failed: ${error.message}`);
  }

  browserPath = resolveBrowserPath();
  if (!browserPath) {
    throw new Error(
      'No usable browser found. Install Chrome/Edge or set PUPPETEER_EXECUTABLE_PATH.'
    );
  }
  log(`Browser ready: ${browserPath}`);
}

async function verifyRender() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      log(`Test render attempt ${attempt}/${maxAttempts}...`);
      await run('node', ['index.js', 'test']);
      log('Test render completed.');
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }
      log(`Test render failed (${error.message}). Retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  log('Setup started.');
  await ensureBrowser();
  await verifyRender();
  log('Setup finished.');
}

main().catch((error) => {
  console.error(`[setup] FAILED: ${error.message}`);
  process.exitCode = 1;
});
