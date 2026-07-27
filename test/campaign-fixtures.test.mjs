import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const campaignCli = path.join(repositoryRoot, "plugins", "vision", "scripts", "vision-campaign.mjs");
const sourceManifest = path.join(repositoryRoot, "evaluation", "campaign", "manifest.local.json");

function runNode(args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("four local real-goal fixtures fail as no-ops and pass three clean oracle trials", { timeout: 120_000 }, async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-real-goals-"));
  const manifestPath = path.join(path.dirname(sourceManifest), `.manifest.test-${process.pid}-${Date.now()}.json`);
  try {
    // This suite validates fixture and oracle integrity.  It never runs an agent,
    // so use a deterministic raw-JSONL runner rather than requiring a locally
    // installed Codex binary on every CI platform.
    const manifest = JSON.parse(await fs.readFile(sourceManifest, "utf8"));
    manifest.execution.codex = {
      mode: "raw-jsonl",
      command: process.execPath,
      prefix_args: [],
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const init = await runNode([campaignCli, "init", "--manifest", manifestPath, "--root", temporaryRoot, "--json"]);
    assert.equal(init.code, 0, init.stderr);
    const preflight = await runNode([campaignCli, "preflight", "--root", temporaryRoot, "--json"]);
    assert.equal(preflight.code, 0, preflight.stderr);
    const report = JSON.parse(preflight.stdout);
    assert.equal(report.valid, true);
    assert.deepEqual(report.tasks.map((task) => task.id), ["logic-cli", "data-async", "ui-real-api", "security-config"]);
    for (const task of report.tasks) {
      assert.equal(task.classification, "VALID_TASK", task.id);
      assert.equal(task.no_op.visible_passed, true, `${task.id} base regressions`);
      assert.equal(task.no_op.target_failed, true, `${task.id} no-op target`);
      assert.equal(task.oracle.length, 3, task.id);
      assert.equal(task.oracle.every((trial) => trial.passed), true, `${task.id} oracle`);
      assert.match(task.base_sha256, /^[a-f0-9]{64}$/);
      assert.match(task.oracle_sha256, /^[a-f0-9]{64}$/);
    }
  } finally {
    await fs.rm(manifestPath, { force: true });
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
