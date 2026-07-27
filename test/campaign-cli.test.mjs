import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { appendLedgerEvent, sha256Value } from "../plugins/vision/scripts/campaign-core.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const campaignCli = path.join(repositoryRoot, "plugins", "vision", "scripts", "vision-campaign.mjs");

function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || repositoryRoot,
      env: options.env || process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal, stdout, stderr }));
  });
}

test("campaign CLI preflights no-op and oracle, runs a paired fixture, resumes idempotently, and verifies replay", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-campaign-cli-"));
  const base = path.join(temporaryRoot, "base");
  const oracle = path.join(temporaryRoot, "oracle");
  const campaignRoot = path.join(temporaryRoot, "campaign");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.mjs");
  const visible = path.join(temporaryRoot, "visible.mjs");
  const grader = path.join(temporaryRoot, "grader.mjs");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(oracle, { recursive: true });
  await fs.writeFile(path.join(base, "solution.txt"), "wrong\n", "utf8");
  await fs.writeFile(path.join(oracle, "solution.txt"), "fixed\n", "utf8");
  await fs.writeFile(visible, "process.exit(0);\n", "utf8");
  await fs.writeFile(grader, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const value = await fs.readFile(path.join(process.argv[2], 'solution.txt'), 'utf8');",
    "if (value.trim() !== 'fixed') { console.error('target still broken'); process.exit(1); }",
    "console.log('target passed');",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(fakeCodex, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
    "const gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT || 0) - 1;",
    "if (gitConfigIndex < 0 || process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`] !== 'safe.directory') process.exit(9);",
    "if (await fs.realpath(process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`] || '') !== await fs.realpath(process.cwd())) process.exit(9);",
    "await new Promise((resolve) => setTimeout(resolve, 250));",
    "await fs.writeFile(path.join(process.cwd(), 'solution.txt'), 'fixed\\n', 'utf8');",
    "console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'}));",
    "console.log(JSON.stringify({type:'turn.started'}));",
    "console.log(JSON.stringify({type:'item.completed',item:{id:'item_0',type:'command_execution',status:'completed',exit_code:0,aggregated_output:'secret: \\\"from-file\\\"'}}));",
    "if (prompt.includes('Use bounded')) console.log('{broken');",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:prompt.length,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}));",
    "",
  ].join("\n"), "utf8");
  const manifest = {
    schema_version: 1,
    campaign_id: "C-cli-fixture",
    description: "CLI fixture",
    arms: [
      { id: "lean", prompt_prefix: "Solve the task." },
      { id: "vision", prompt_prefix: "Use bounded research, implementation, and verification." },
    ],
    epochs: 1,
    oracle_repetitions: 2,
    heartbeat_ms: 25,
    max_credible_gap_ms: 500,
    runner_lock_stale_ms: 1_000,
    execution: {
      timeout_ms: 5_000,
      codex: { mode: "raw-jsonl", command: process.execPath, prefix_args: [fakeCodex] },
    },
    tasks: [{
      id: "fixture",
      base_dir: base,
      oracle_dir: oracle,
      prompt: "Change solution.txt from wrong to fixed.",
      visible_checks: [{ id: "visible", command: process.execPath, args: [visible] }],
      grader: { id: "hidden-target", command: process.execPath, args: [grader, "{workspace}"], artifacts: [grader] },
    }],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  try {
    const help = await runNode([campaignCli, "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /preflight/);
    assert.match(help.stdout, /resume/);
    assert.match(help.stdout, /cancel/);

    const initialized = await runNode([campaignCli, "init", "--manifest", manifestPath, "--root", campaignRoot, "--json"]);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).campaign_id, "C-cli-fixture");

    const preflight = await runNode([campaignCli, "preflight", "--root", campaignRoot, "--json"]);
    assert.equal(preflight.code, 0, preflight.stderr);
    const preflightReport = JSON.parse(preflight.stdout);
    assert.equal(preflightReport.schema_version, 2);
    assert.equal(preflightReport.tasks[0].classification, "VALID_TASK");
    assert.equal(preflightReport.tasks[0].no_op.target_failed, true);
    assert.equal(preflightReport.tasks[0].oracle.every((trial) => trial.passed), true);
    assert.match(preflightReport.tasks[0].grader_artifacts_sha256, /^[a-f0-9]{64}$/);

    const staleLock = path.join(campaignRoot, ".runner.lock");
    await fs.writeFile(staleLock, `${JSON.stringify({ schema_version: 1, token: "stale", pid: 2_000_000_000 })}\n`, "utf8");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(staleLock, staleTime, staleTime);

    const concurrentRuns = await Promise.all([
      runNode([campaignCli, "run", "--root", campaignRoot, "--json"]),
      runNode([campaignCli, "run", "--root", campaignRoot, "--json"]),
    ]);
    const successfulRuns = concurrentRuns.filter((result) => result.code === 0);
    const refusedRuns = concurrentRuns.filter((result) => result.code !== 0);
    assert.equal(successfulRuns.length, 1, concurrentRuns.map((result) => result.stderr).join("\n"));
    assert.equal(refusedRuns.length, 1);
    assert.match(refusedRuns[0].stderr, /campaign runner is already active/i);
    const runReport = JSON.parse(successfulRuns[0].stdout);
    assert.equal(runReport.attempts.length, 2);
    assert.deepEqual(runReport.attempts.map((attempt) => attempt.classification).sort(), ["INCONCLUSIVE_INFRA", "VALID_PASS"]);

    const resumed = await runNode([campaignCli, "resume", "--root", campaignRoot, "--json"]);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).attempts.length, 0);

    const verified = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.equal(verified.code, 0, verified.stderr);
    const verdict = JSON.parse(verified.stdout);
    assert.equal(verdict.valid, true, verdict.errors?.join("\n"));
    assert.equal(verdict.conclusive, false);
    assert.match(verdict.warnings.join("\n"), /inconclusive infrastructure evidence/i);
    assert.equal(verdict.attempts.planned, 2);
    assert.equal(verdict.attempts.terminal, 2);
    assert.equal(verdict.outcomes.VALID_PASS, 1);
    assert.equal(verdict.outcomes.INCONCLUSIVE_INFRA, 1);
    assert.equal(verdict.calibration.by_arm.lean.full_solves, 1);
    assert.equal(verdict.calibration.by_arm.vision.full_solves, 0);
    assert.equal(verdict.calibration.reliability.clean_passes, 1);
    assert.equal(verdict.calibration.reliability.retry_only_passes, 0);
    assert.equal(verdict.calibration.infrastructure_failures, 1);
    assert.equal(verdict.calibration.cost.available, false);
    assert.equal(verdict.calibration.cost.estimated_usd, null);

    const attemptKeys = await fs.readdir(path.join(campaignRoot, "attempts"));
    for (const attemptKey of attemptKeys) {
      const durableLines = (await fs.readFile(path.join(campaignRoot, "attempts", attemptKey, "codex.jsonl"), "utf8")).trim().split(/\r?\n/);
      for (const line of durableLines) assert.doesNotThrow(() => JSON.parse(line));
      assert.doesNotMatch(durableLines.join("\n"), /from-file/);
    }

    const [attemptKey] = attemptKeys;
    const candidateFile = path.join(campaignRoot, "attempts", attemptKey, "workspace", "solution.txt");
    const candidateBytes = await fs.readFile(candidateFile);
    await fs.writeFile(candidateFile, "mutated after receipt\n", "utf8");
    const mutated = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(mutated.code, 0);
    assert.match(JSON.parse(mutated.stdout).errors.join("\n"), /candidate hash mismatch/);
    await fs.writeFile(candidateFile, candidateBytes);
    const restored = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.equal(restored.code, 0, restored.stderr);

    const traceFile = path.join(campaignRoot, "attempts", attemptKey, "codex.jsonl");
    const traceBytes = await fs.readFile(traceFile);
    await fs.writeFile(traceFile, `${traceBytes.toString("utf8")}{}\n`, "utf8");
    const mutatedTrace = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(mutatedTrace.code, 0);
    assert.match(JSON.parse(mutatedTrace.stdout).errors.join("\n"), /Codex trace hash mismatch/);
    await fs.writeFile(traceFile, traceBytes);

    const sealedBaseFile = path.join(base, "solution.txt");
    const sealedBaseBytes = await fs.readFile(sealedBaseFile);
    await fs.writeFile(sealedBaseFile, "changed fixture after preflight\n", "utf8");
    const staleFixture = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(staleFixture.code, 0);
    assert.match(JSON.parse(staleFixture.stdout).errors.join("\n"), /preflight base hash mismatch/);
    await fs.writeFile(sealedBaseFile, sealedBaseBytes);

    const graderBytes = await fs.readFile(grader);
    await fs.writeFile(grader, `${graderBytes.toString("utf8")}\n// mutated evaluator\n`, "utf8");
    const staleGrader = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(staleGrader.code, 0);
    assert.match(JSON.parse(staleGrader.stdout).errors.join("\n"), /preflight grader artifact hash mismatch/);
    await fs.writeFile(grader, graderBytes);

    const cancelled = await runNode([campaignCli, "cancel", "--root", campaignRoot, "--reason", "manual fixture", "--json"]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).cancel_requested, true);
    const status = await runNode([campaignCli, "status", "--root", campaignRoot, "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).cancel_requested, true);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("campaign verifier rejects incomplete planned cells and a tampered attempt event", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-campaign-incomplete-"));
  const base = path.join(temporaryRoot, "base");
  const oracle = path.join(temporaryRoot, "oracle");
  const campaignRoot = path.join(temporaryRoot, "campaign");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(oracle, { recursive: true });
  await fs.writeFile(path.join(base, "value"), "bad", "utf8");
  await fs.writeFile(path.join(oracle, "value"), "good", "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    campaign_id: "C-incomplete",
    arms: [{ id: "lean", prompt_prefix: "" }],
    epochs: 1,
    execution: { timeout_ms: 1_000, codex: { mode: "raw-jsonl", command: process.execPath, prefix_args: [] } },
    tasks: [{ id: "t", base_dir: base, oracle_dir: oracle, prompt: "fix", visible_checks: [], grader: { id: "g", command: process.execPath, args: ["-e", "process.exit(1)"] } }],
  }, null, 2)}\n`, "utf8");
  try {
    assert.equal((await runNode([campaignCli, "init", "--manifest", manifestPath, "--root", campaignRoot])).code, 0);
    const verify = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(verify.code, 0);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.valid, false);
    assert.match(report.errors.join("\n"), /planned attempts are not terminal/);

    const frozen = JSON.parse(await fs.readFile(path.join(campaignRoot, "frozen-manifest.json"), "utf8"));
    const partial = {
      run_key: sha256Value({ manifest_sha256: frozen.manifest_sha256, task_id: "t", arm_id: "lean", epoch: 1 }),
      task_id: "t",
      arm_id: "lean",
      epoch: 1,
      partition: "primary",
    };
    await appendLedgerEvent({
      ledger_dir: path.join(campaignRoot, "campaign", "events"),
      campaign_id: "C-incomplete",
      ledger_kind: "campaign",
      event_type: "run_admitted",
      state_after: "support_active",
      scope: partial,
      payload: { manifest_sha256: frozen.manifest_sha256 },
    });
    await appendLedgerEvent({
      ledger_dir: path.join(campaignRoot, "attempts", partial.run_key, "events"),
      campaign_id: "C-incomplete",
      ledger_kind: "attempt",
      event_type: "attempt_created",
      state_after: "setup_active",
      scope: partial,
      payload: { manifest_sha256: frozen.manifest_sha256 },
    });
    await appendLedgerEvent({
      ledger_dir: path.join(campaignRoot, "attempts", partial.run_key, "events"),
      campaign_id: "C-incomplete",
      ledger_kind: "attempt",
      event_type: "model_started",
      state_after: "model_inflight",
      scope: partial,
      payload: { prompt_sha256: "f".repeat(64) },
    });
    const partialVerify = await runNode([campaignCli, "verify", "--root", campaignRoot, "--json"]);
    assert.notEqual(partialVerify.code, 0);
    const partialReport = JSON.parse(partialVerify.stdout);
    assert.deepEqual(partialReport.partial_attempts, [{
      run_key: partial.run_key,
      task_id: "t",
      arm_id: "lean",
      epoch: 1,
      last_event_type: "model_started",
      state_after: "model_inflight",
    }]);
    assert.match(partialReport.errors.join("\n"), /partial admitted attempt/i);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("duration stopping completes the primary matrix before ending reliability admission", { timeout: 30_000 }, async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-campaign-duration-"));
  const base = path.join(temporaryRoot, "base");
  const oracle = path.join(temporaryRoot, "oracle");
  const campaignRoot = path.join(temporaryRoot, "campaign");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.mjs");
  const grader = path.join(temporaryRoot, "grader.mjs");
  const manifestPath = path.join(temporaryRoot, "manifest.json");
  await fs.mkdir(base, { recursive: true });
  await fs.mkdir(oracle, { recursive: true });
  await fs.writeFile(path.join(base, "value"), "bad", "utf8");
  await fs.writeFile(path.join(oracle, "value"), "good", "utf8");
  await fs.writeFile(grader, "import fs from 'node:fs'; process.exit(fs.readFileSync(process.argv[2] + '/value', 'utf8') === 'good' ? 0 : 1);\n", "utf8");
  await fs.writeFile(fakeCodex, [
    "import fs from 'node:fs/promises';",
    "await new Promise((resolve) => setTimeout(resolve, 40));",
    "await fs.writeFile('value', 'good');",
    "console.log(JSON.stringify({type:'thread.started',thread_id:'duration'}));",
    "console.log(JSON.stringify({type:'turn.started'}));",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}));",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify({
    schema_version: 1,
    campaign_id: "C-duration",
    arms: [{ id: "lean", prompt_prefix: "" }, { id: "vision", prompt_prefix: "bounded" }],
    primary_epochs: 1,
    epochs: 3,
    stop_after_eligible_hours: 0.00001,
    oracle_repetitions: 1,
    heartbeat_ms: 10,
    max_credible_gap_ms: 500,
    execution: { timeout_ms: 2_000, codex: { mode: "raw-jsonl", command: process.execPath, prefix_args: [fakeCodex] } },
    tasks: [{ id: "t", base_dir: base, oracle_dir: oracle, prompt: "fix", visible_checks: [], grader: { id: "g", command: process.execPath, args: [grader, "{workspace}"], artifacts: [grader] } }],
  }, null, 2)}\n`, "utf8");
  try {
    assert.equal((await runNode([campaignCli, "init", "--manifest", manifestPath, "--root", campaignRoot])).code, 0);
    assert.equal((await runNode([campaignCli, "preflight", "--root", campaignRoot])).code, 0);
    const run = await runNode([campaignCli, "run", "--root", campaignRoot, "--json"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).attempts.length, 2, "both primary arms must finish before duration stop");
    const verify = await runNode([campaignCli, "verify", "--root", campaignRoot, "--require-accounted-hours", "0.00001", "--json"]);
    assert.equal(verify.code, 0, verify.stderr);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.valid, true, report.errors.join("\n"));
    assert.deepEqual(report.attempts, { planned: 6, admitted: 2, terminal: 2, partial: 0, primary_required: 2 });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("campaign initialization rejects duplicate run identities and invalid primary bounds", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vision-campaign-shape-"));
  const baseManifest = {
    schema_version: 1,
    campaign_id: "C-shape",
    arms: [{ id: "lean", prompt_prefix: "" }],
    epochs: 1,
    tasks: [{ id: "task", base_dir: temporaryRoot, oracle_dir: temporaryRoot, prompt: "fix", visible_checks: [], grader: { command: process.execPath, args: [] } }],
  };
  const cases = [
    { label: "duplicate arm id", manifest: { ...baseManifest, arms: [{ id: "same" }, { id: "same" }] }, pattern: /duplicate campaign arm id/i },
    { label: "duplicate task id", manifest: { ...baseManifest, tasks: [...baseManifest.tasks, { ...baseManifest.tasks[0] }] }, pattern: /duplicate campaign task id/i },
    { label: "invalid primary bound", manifest: { ...baseManifest, primary_epochs: 2 }, pattern: /primary_epochs/i },
  ];
  try {
    for (const [index, fixture] of cases.entries()) {
      const manifestPath = path.join(temporaryRoot, `manifest-${index}.json`);
      await fs.writeFile(manifestPath, `${JSON.stringify(fixture.manifest)}\n`, "utf8");
      const result = await runNode([campaignCli, "init", "--manifest", manifestPath, "--root", path.join(temporaryRoot, `campaign-${index}`)]);
      assert.notEqual(result.code, 0, fixture.label);
      assert.match(result.stderr, fixture.pattern, fixture.label);
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
