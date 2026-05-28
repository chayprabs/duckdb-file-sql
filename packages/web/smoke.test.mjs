import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const SAMPLE_COUNTS = [
  { label: "Ecommerce Events", expected: "4" },
  { label: "Weather Events", expected: "3" },
  { label: "Customer Profiles", expected: "3" },
  { label: "City Tiers", expected: "3" },
  { label: "People TSV", expected: "3" },
  { label: "Inventory JSON", expected: "3" },
  { label: "Metrics Arrow", expected: "3" },
  { label: "NYC Taxi Sample", expected: "4" },
  { label: "Chinook Lite", expected: "3" },
];

const EXPECTED_EXPLAIN_SNAPSHOT = [
  "UNGROUPED_AGGREGATE",
  "count_star()",
].join("\n");

async function main() {
  const WEB_PORT = await getAvailablePort();
  const WORKER_PORT = await getAvailablePort();
  const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
  const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
  const cleanup = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const workerLaunch = getWorkerLaunch(WORKER_PORT);
    const webLaunch = getWebLaunch(WEB_PORT);
    cleanup.push(
      await startOwnedService(
        `${WORKER_URL}/health`,
        "worker",
        workerLaunch.command,
        workerLaunch.args,
        {},
        workerLaunch.cwd,
      ),
    );
    cleanup.push(
      await startOwnedService(
        WEB_URL,
        "web",
        webLaunch.command,
        webLaunch.args,
        {
          FILESQL_WORKER_PROXY_TARGET: WORKER_URL,
        },
        webLaunch.cwd,
      ),
    );

    for (const sample of SAMPLE_COUNTS) {
      console.log(`Smoke-checking ${sample.label}`);
      const page = await browser.newPage();
      try {
        await page.goto(WEB_URL, { waitUntil: "load" });
        await clickSample(page, sample.label);
        await waitForRunReady(page, sample.label);
        await page.getByRole("button", { name: "Run query", exact: true }).click();
        await page.locator("tbody td").first().waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await firstBodyCell(page), sample.expected);
      } finally {
        await page.close();
      }
    }

    console.log("Capturing EXPLAIN snapshot");
    const explainPage = await browser.newPage();
    try {
      await explainPage.goto(WEB_URL, { waitUntil: "load" });
      await clickSample(explainPage, "NYC Taxi Sample");
      await waitForRunReady(explainPage, "NYC Taxi Sample");
      await explainPage.getByRole("button", { name: "Explain", exact: true }).click();
      await explainPage.locator(".plan-output").waitFor({ state: "visible", timeout: 20_000 });
      const planText = await explainPage.locator(".plan-output").innerText();
      const normalizedPlan = normalizeExplainSnapshot(planText);
      assert.equal(normalizedPlan, EXPECTED_EXPLAIN_SNAPSHOT);
    } finally {
      await explainPage.close();
    }

    console.log("Web smoke tests passed");
  } finally {
    await browser.close();
    await Promise.allSettled(cleanup.reverse().map((terminate) => terminate()));
  }
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

async function firstBodyCell(page) {
  return (await page.locator("tbody td").first().innerText()).trim();
}

function normalizeExplainSnapshot(planText) {
  return planText
    .split("\n")
    .map((line) => line.replace(/[│┌┐└┘─]/g, " ").trim())
    .filter(Boolean)
    .filter((line) => /UNGROUPED_AGGREGATE|count_star\(\)/.test(line))
    .join("\n");
}

function getWorkerLaunch(workerPort) {
  const cwd = path.join(ROOT, "apps", "worker");
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `python -m uvicorn app.main:app --host 127.0.0.1 --port ${workerPort}`,
      ],
      cwd,
    };
  }

  return {
    command: "python3",
    args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", `${workerPort}`],
    cwd,
  };
}

function getWebLaunch(webPort) {
  const cwd = path.join(ROOT, "packages", "web");
  if (process.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `pnpm --filter @filesql/web dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      ],
      cwd: ROOT,
    };
  }

  return {
    command: path.join(cwd, "node_modules", ".bin", "vite"),
    args: ["--host", "127.0.0.1", "--port", `${webPort}`, "--strictPort"],
    cwd,
  };
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to determine an available port.")));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startOwnedService(url, name, command, args, extraEnv = {}, cwd = ROOT) {
  const service = await startProcess(name, command, args, extraEnv, cwd);
  try {
    await waitForUrl(url);
    return service.terminate;
  } catch (error) {
    await service.terminate();
    const output = service.readOutput();
    if (output) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
    }
    throw error;
  }
}

async function startProcess(name, command, args, extraEnv = {}, cwd = ROOT) {
  const output = [];
  let isStopping = false;
  const child = spawn(command, args, {
    cwd,
    detached: false,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk) => appendOutput(output, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(output, chunk));

  child.once("exit", (code) => {
    if (!isStopping && code && code !== 0) {
      console.warn(`${name} exited early with code ${code}`);
    }
  });

  return {
    readOutput() {
      return output.join("").trim();
    },
    async terminate() {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      isStopping = true;
      await terminateChildProcess(child);
    },
  };
}

function appendOutput(output, chunk) {
  output.push(chunk.toString());
  if (output.length > 50) {
    output.shift();
  }
}

async function terminateChildProcess(child) {
  await new Promise((resolve) => {
    child.once("exit", () => resolve());

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", `${child.pid}`, "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
      return;
    }

    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }, 2_000).unref();
  });
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

await main();
