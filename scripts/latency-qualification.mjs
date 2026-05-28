import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const ROOT = process.cwd();
const portOffset = Number(process.env.FILESQL_LATENCY_PORT_OFFSET ?? Math.floor(Math.random() * 200));
const WEB_PORT = Number(process.env.FILESQL_LATENCY_WEB_PORT ?? 4500 + portOffset);
const WORKER_PORT = Number(process.env.FILESQL_LATENCY_WORKER_PORT ?? 8200 + portOffset);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;

const BROWSER_TARGET_BYTES = Number(
  process.env.FILESQL_BROWSER_BENCH_TARGET_BYTES ?? 100 * 1024 * 1024,
);
const WORKER_TARGET_BYTES = Number(
  process.env.FILESQL_WORKER_BENCH_TARGET_BYTES ?? 5 * 1024 * 1024 * 1024,
);
const REPEATS = Number(process.env.FILESQL_LATENCY_REPEATS ?? 5);
const SKIP_BROWSER = process.env.FILESQL_SKIP_BROWSER_BENCH === "1";
const SKIP_WORKER = process.env.FILESQL_SKIP_WORKER_BENCH === "1";
const BROWSER_THRESHOLD_MS = 1_000;
const WORKER_THRESHOLD_MS = 20_000;

const artifactDir = path.join(ROOT, "artifacts", "benchmarks");
const browserFixturePath = path.join(artifactDir, "browser-latency.parquet");
const workerFixturePath = path.join(artifactDir, "worker-latency.parquet");
const outputPath = path.join(ROOT, "artifacts", "latency-report.json");

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    browser: null,
    worker: null,
    thresholds: {
      browserP95Ms: BROWSER_THRESHOLD_MS,
      workerP95Ms: WORKER_THRESHOLD_MS,
    },
    targets: {
      browserBytes: BROWSER_TARGET_BYTES,
      workerBytes: WORKER_TARGET_BYTES,
      repeats: REPEATS,
    },
  };

  const cleanup = [];
  try {
    if (!SKIP_BROWSER) {
      await ensureFixture(browserFixturePath, BROWSER_TARGET_BYTES);
    }
    if (!SKIP_WORKER) {
      await ensureFixture(workerFixturePath, WORKER_TARGET_BYTES);
    }

    cleanup.push(await startOwnedService(`${WORKER_URL}/health`, "worker", "powershell", [
      "-NoProfile",
      "-Command",
      `Set-Location '${path.join(ROOT, "apps", "worker")}'; python -m uvicorn app.main:app --host 127.0.0.1 --port ${WORKER_PORT}`,
    ]));
    cleanup.push(await startOwnedService(WEB_URL, "web", "powershell", [
      "-NoProfile",
      "-Command",
      `Set-Location '${ROOT}'; pnpm --filter @filesql/web dev -- --host 127.0.0.1 --port ${WEB_PORT}`,
    ], {
      FILESQL_WORKER_PROXY_TARGET: WORKER_URL,
    }));

    if (!SKIP_BROWSER) {
      const browser = await chromium.launch({ headless: true });
      try {
        report.browser = await measureBrowserLatency(browser, browserFixturePath);
      } finally {
        await browser.close();
      }
    }

    if (!SKIP_WORKER) {
      report.worker = await measureWorkerLatency(workerFixturePath);
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Wrote latency report to ${outputPath}`);
  } finally {
    await Promise.allSettled(cleanup.reverse().map((terminate) => terminate()));
  }
}

async function ensureFixture(outputPath, targetBytes) {
  let stats = null;
  try {
    stats = await fs.stat(outputPath);
  } catch {}

  if (stats && stats.size >= targetBytes * 0.98) {
    return;
  }

  await runCommand("python", [
    path.join(ROOT, "scripts", "generate-parquet-benchmark.py"),
    "--output",
    outputPath,
    "--target-bytes",
    String(targetBytes),
  ]);
}

async function measureBrowserLatency(browser, fixturePath) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  await page.locator('input[type="file"]').setInputFiles(fixturePath);
  await waitForRunReady(page, "browser benchmark fixture");
  await warmBrowser(page);

  const samples = [];
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const started = Date.now();
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await page.getByRole("button", { name: "Run query", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      () => {
        const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Run query");
        return Boolean(button);
      },
      { timeout: 30_000 },
    );
    await page.locator("tbody td").first().waitFor({ state: "visible", timeout: 30_000 });
    samples.push(Date.now() - started);
  }

  const rowValue = (await page.locator("tbody td").first().innerText()).trim();
  await page.close();

  return {
    actualBytes: (await fs.stat(fixturePath)).size,
    p95Ms: percentile95(samples),
    samplesMs: samples,
    passed: percentile95(samples) <= BROWSER_THRESHOLD_MS,
    totalRows: rowValue,
  };
}

async function warmBrowser(page) {
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.locator("tbody td").first().waitFor({ state: "visible", timeout: 30_000 });
}

async function measureWorkerLatency(fixturePath) {
  const payload = {
    sql: "SELECT COUNT(*) AS total_rows FROM worker_latency",
    tables: [{ name: "worker_latency", source: fixturePath.replaceAll("\\", "/"), kind: "parquet" }],
  };

  await postWorkerQuery(payload);

  const samples = [];
  let totalRows = null;
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const started = Date.now();
    const response = await postWorkerQuery(payload);
    samples.push(Date.now() - started);
    totalRows = response.rows?.[0]?.[0] ?? null;
  }

  return {
    actualBytes: (await fs.stat(fixturePath)).size,
    p95Ms: percentile95(samples),
    samplesMs: samples,
    passed: percentile95(samples) <= WORKER_THRESHOLD_MS,
    totalRows,
  };
}

async function postWorkerQuery(payload) {
  const response = await fetch(`${WORKER_URL}/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Worker benchmark request failed with ${response.status}.`);
  }
  return response.json();
}

function percentile95(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      detached: false,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function startProcess(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: false,
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
    windowsHide: true,
  });

  child.once("exit", (code) => {
    if (code && code !== 0) {
      console.warn(`${name} exited early with code ${code}`);
    }
  });

  return async () => {
    if (!child.killed) {
      child.kill();
    }
  };
}

async function startOwnedService(url, name, command, args, extraEnv = {}) {
  const terminate = await startProcess(name, command, args, extraEnv);
  await waitForUrl(url);
  return terminate;
}

async function waitForUrl(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isUrlReady(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isUrlReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRunReady(page, label = "fixture") {
  const button = page.getByRole("button", { name: "Run query", exact: true });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await button.isEnabled()) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Run query stayed disabled after loading ${label}.`);
}

await main();
