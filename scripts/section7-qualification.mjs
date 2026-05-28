import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { chromium } from "playwright";

const ROOT = process.cwd();
const portOffset = Number(process.env.FILESQL_PORT_OFFSET ?? Math.floor(Math.random() * 200));
const WEB_PORT = Number(process.env.FILESQL_WEB_PORT ?? 4300 + portOffset);
const WORKER_PORT = Number(process.env.FILESQL_WORKER_PORT ?? 8000 + portOffset);
const SAMPLE_PORT = Number(process.env.FILESQL_SAMPLE_PORT ?? 8700 + portOffset);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const SAMPLE_URL = `http://127.0.0.1:${SAMPLE_PORT}`;

const SAMPLE_COUNTS = [
  { label: "Ecommerce Events", expected: "4" },
  { label: "Weather Events", expected: "3" },
  { label: "Customer Profiles", expected: "3" },
  { label: "City Tiers", expected: "3" },
  { label: "People TSV", expected: "3" },
  { label: "Inventory JSON", expected: "3" },
  { label: "Metrics Arrow", expected: "3" },
  { label: "NYC Taxi Sample", expected: "4" },
];

const JOIN_SQL = [
  "SELECT city_tiers.region, COUNT(*) AS event_count, SUM(ecommerce_events.orders) AS total_orders",
  "FROM ecommerce_events",
  "JOIN customer_profiles ON ecommerce_events.user_id = customer_profiles.user_id",
  "JOIN city_tiers ON ecommerce_events.city = city_tiers.city",
  "GROUP BY 1",
  "ORDER BY 1;",
].join("\n");

const report = {
  generatedAt: new Date().toISOString(),
  webUrl: WEB_URL,
  workerUrl: WORKER_URL,
  sampleUrl: SAMPLE_URL,
  lazyLoad: { initialDuckdbRequests: [], afterLoadDuckdbRequests: [] },
  counts: [],
  acceptance: {},
};

async function main() {
  const cleanup = [];
  try {
    cleanup.push(await startOwnedService(`${WORKER_URL}/health`, "worker", "powershell", [
      "-NoProfile",
      "-Command",
      `Set-Location '${path.join(ROOT, "apps", "worker")}'; python -m uvicorn app.main:app --host 127.0.0.1 --port ${WORKER_PORT}`,
    ]));
    cleanup.push(await startOwnedService(`${SAMPLE_URL}/ecommerce-events.csv`, "samples", "powershell", [
      "-NoProfile",
      "-Command",
      `Set-Location '${ROOT}'; python -m http.server ${SAMPLE_PORT} --bind 127.0.0.1 --directory packages/web/public/samples`,
    ]));
    cleanup.push(await startOwnedService(WEB_URL, "web", "powershell", [
      "-NoProfile",
      "-Command",
      `Set-Location '${ROOT}'; pnpm --filter @filesql/web dev -- --host 127.0.0.1 --port ${WEB_PORT}`,
    ], {
      FILESQL_WORKER_PROXY_TARGET: WORKER_URL,
    }));

    const browser = await chromium.launch({ headless: true });
    try {
      await verifyLazyLoad(browser);
      await verifySampleCounts(browser);
      await verifySqliteSample(browser);
      await verifyRemoteUrl(browser);
      await verifyA1(browser);
      await verifyA2(browser);
      await verifyA3(browser);
    } finally {
      await browser.close();
    }

    const outputDir = path.join(ROOT, "artifacts");
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, "section7-report.json");
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Wrote Section 7 report to ${outputPath}`);
  } finally {
    await Promise.allSettled(cleanup.reverse().map((terminate) => terminate()));
  }
}

async function verifyLazyLoad(browser) {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(WEB_URL, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  report.lazyLoad.initialDuckdbRequests = requests.filter((url) => isDuckDbAsset(url));
  await clickSample(page, "NYC Taxi Sample");
  await page.waitForTimeout(5000);
  report.lazyLoad.afterLoadDuckdbRequests = requests.filter((url) => isDuckDbAsset(url));
  await page.close();
}

async function verifySampleCounts(browser) {
  for (const sample of SAMPLE_COUNTS) {
    console.log(`Checking sample count for ${sample.label}`);
    const page = await browser.newPage();
    await page.goto(WEB_URL, { waitUntil: "load" });
    await clickSample(page, sample.label);
    await waitForRunReady(page, sample.label);
    await page.getByRole("button", { name: "Run query", exact: true }).click();
    await page.waitForTimeout(1500);
    const value = await firstBodyCell(page);
    report.counts.push({ label: sample.label, expected: sample.expected, actual: value });
    await page.close();
  }
}

async function verifyRemoteUrl(browser) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  await page.locator('input[type="url"]').fill(`${SAMPLE_URL}/ecommerce-events.csv`);
  await page.locator("select").selectOption("csv");
  await page.getByRole("button", { name: "Add remote URL", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.waitForTimeout(1800);
  report.acceptance.remoteUrl = {
    bodyCell: await firstBodyCell(page),
    ranOnWorker: (await page.locator("body").innerText()).includes("Executed in worker mode"),
  };
  await page.close();
}

async function verifySqliteSample(browser) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  await clickSample(page, "Chinook Lite");
  await waitForRunReady(page, "Chinook Lite");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.waitForTimeout(1800);
  report.counts.push({ label: "Chinook Lite", expected: "3", actual: await firstBodyCell(page) });
  await page.close();
}

async function verifyA1(browser) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  await clickSample(page, "NYC Taxi Sample");
  await waitForRunReady(page);
  const start = Date.now();
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.locator("tbody td").first().waitFor({ state: "visible", timeout: 10_000 });
  report.acceptance.a1 = {
    totalRows: await firstBodyCell(page),
    elapsedMs: Date.now() - start,
  };
  await page.close();
}

async function verifyA2(browser) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  for (const label of ["Ecommerce Events", "Customer Profiles", "City Tiers"]) {
    await clickSample(page, label);
    await waitForRunReady(page);
  }
  await setEditorValue(page, JOIN_SQL);
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.waitForTimeout(1500);
  report.acceptance.a2 = {
    rows: await page.locator("tbody tr").allInnerTexts(),
  };
  await page.close();
}

async function verifyA3(browser) {
  const page = await browser.newPage();
  await page.goto(WEB_URL, { waitUntil: "load" });
  const oversizedPath = await createOversizedFixture();
  await page.locator('input[type="file"]').setInputFiles(oversizedPath);
  await page.waitForTimeout(800);
  const body = await page.locator("body").innerText();
  report.acceptance.a3 = {
    promptVisible: body.toLowerCase().includes("escalation required"),
    cancelVisible: body.toLowerCase().includes("cancel"),
  };
  await fs.rm(oversizedPath, { force: true });
  await page.close();
}

async function clickSample(page, label) {
  await page.locator(".sample-button").filter({ hasText: label }).click();
}

async function waitForRunReady(page, label = "sample") {
  const button = page.getByRole("button", { name: "Run query", exact: true });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await button.isEnabled()) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Run query stayed disabled after loading ${label}.`);
}

async function setEditorValue(page, sql) {
  await page.evaluate((nextSql) => {
    const editor = window.monaco?.editor?.getModels?.()?.[0];
    if (!editor) {
      throw new Error("Monaco editor model is unavailable.");
    }
    editor.setValue(nextSql);
  }, sql);
}

async function firstBodyCell(page) {
  return (await page.locator("tbody td").first().innerText()).trim();
}

function isDuckDbAsset(url) {
  return /(@duckdb|duckdb-browser|duckdb-(eh|mvp)\.wasm|browser-session|duckdb-wasm)/i.test(url);
}

async function createOversizedFixture() {
  const target = path.join(os.tmpdir(), "filesql-oversized.parquet");
  if (process.platform === "win32") {
    const result = spawnSync("fsutil", ["file", "createnew", target, "1100000000"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error("Failed to create oversized fixture with fsutil.");
    }
    return target;
  }

  const handle = await fs.open(target, "w");
  await handle.truncate(1_100_000_000);
  await handle.close();
  return target;
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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

await main();
