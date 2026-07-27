#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildCampaignCalibration } from "./campaign-report.mjs";
import {
  appendLedgerEvent,
  freezeCampaignManifest,
  parseCodexJsonl,
  redactSensitiveText,
  replayCampaignAccounting,
  serializeRedactedCodexJsonl,
  sha256Value,
  verifyFrozenManifest,
  verifyLedger,
} from "./campaign-core.mjs";

const FROZEN_MANIFEST = "frozen-manifest.json";
const PREFLIGHT_REPORT = "preflight.json";
const CAMPAIGN_LEDGER = path.join("campaign", "events");
const ATTEMPTS_DIR = "attempts";
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    result[key] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function usage() {
  return `Vision campaign

Commands:
  init --manifest file --root directory [--json]
  preflight --root directory [--json]
  run --root directory [--json]
  resume --root directory [--json]
  status --root directory [--json]
  verify --root directory [--require-accounted-hours n] [--json]
  cancel --root directory --reason text [--json]

The frozen manifest and append-only ledgers are authority. Reports and status are replayable derived views.
`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function removeFileWithRetry(filePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(filePath, { force: true });
      return;
    } catch (error) {
      const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
      if (!retryable || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 5));
    }
  }
}

async function acquireRunnerAcquisitionGuard(campaign) {
  const guardPath = path.join(campaign.root, ".runner.acquire.lock");
  const token = randomUUID();
  await fs.mkdir(campaign.root, { recursive: true });
  for (let acquisition = 0; acquisition < 200; acquisition += 1) {
    let handle;
    try {
      handle = await fs.open(guardPath, "wx", 0o600);
    } catch (error) {
      const contention = error.code === "EEXIST"
        || (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code));
      if (!contention) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const metadata = {
      schema_version: 1,
      token,
      pid: process.pid,
      campaign_id: campaign.manifest.campaign_id,
      acquired_at: new Date().toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    return {
      async release() {
        await handle.close();
        const current = JSON.parse(await fs.readFile(guardPath, "utf8"));
        if (current.token !== token) {
          throw new Error("campaign runner acquisition guard token changed before release");
        }
        await removeFileWithRetry(guardPath);
      },
    };
  }
  let metadata = null;
  try {
    metadata = JSON.parse(await fs.readFile(guardPath, "utf8"));
  } catch {
    throw new Error("campaign runner acquisition guard is not safely reclaimable; inspect .runner.acquire.lock");
  }
  if (!processIsAlive(Number(metadata.pid))) {
    throw new Error(`campaign runner acquisition guard is orphaned (pid ${metadata.pid}); inspect and remove .runner.acquire.lock`);
  }
  throw new Error(`campaign runner is already active (lease acquisition pid ${metadata.pid})`);
}

async function acquireRunnerLeaseUnlocked(campaign) {
  const lockPath = path.join(campaign.root, ".runner.lock");
  const token = randomUUID();
  const staleMs = Number(campaign.manifest.runner_lock_stale_ms || 60_000);
  if (!Number.isSafeInteger(staleMs) || staleMs < 1_000) throw new Error("runner_lock_stale_ms must be an integer of at least 1000");
  for (let acquisition = 0; acquisition < 3; acquisition += 1) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      const contention = error.code === "EEXIST" || (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code));
      if (!contention) throw error;
      let metadata = null;
      let stat = null;
      try {
        metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
        stat = await fs.stat(lockPath);
      } catch {
        throw new Error("campaign runner is already active (lock is not safely reclaimable)");
      }
      if (processIsAlive(Number(metadata.pid))) throw new Error(`campaign runner is already active (pid ${metadata.pid})`);
      if (Date.now() - stat.mtimeMs < staleMs) throw new Error("campaign runner is already active (recent orphan lock)");
      await removeFileWithRetry(lockPath);
      continue;
    }
    const metadata = {
      schema_version: 1,
      token,
      pid: process.pid,
      campaign_id: campaign.manifest.campaign_id,
      manifest_sha256: campaign.frozen.manifest_sha256,
      acquired_at: new Date().toISOString(),
    };
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    const heartbeatMs = Math.max(250, Math.min(Math.floor(staleMs / 3), 5_000));
    let heartbeatError = null;
    let heartbeatPending = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatPending = heartbeatPending.then(async () => {
        const now = new Date();
        await handle.utimes(now, now);
      }).catch((error) => { heartbeatError = error; });
    }, heartbeatMs);
    heartbeat.unref();
    return {
      async release() {
        clearInterval(heartbeat);
        await heartbeatPending;
        await handle.close();
        const current = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (current.token !== token) throw new Error("campaign runner lease token changed before release");
        await removeFileWithRetry(lockPath);
        if (heartbeatError) throw new Error(`campaign runner heartbeat failed: ${heartbeatError.message}`);
      },
    };
  }
  throw new Error("campaign runner lease could not be acquired");
}

async function acquireRunnerLease(campaign) {
  const acquisitionGuard = await acquireRunnerAcquisitionGuard(campaign);
  try {
    return await acquireRunnerLeaseUnlocked(campaign);
  } finally {
    await acquisitionGuard.release();
  }
}

function resolveManifestPaths(manifest, manifestPath) {
  const base = path.dirname(path.resolve(manifestPath));
  const replaceManifestDirectory = (value) => {
    if (typeof value === "string") return value.replaceAll("{manifest_dir}", base);
    if (Array.isArray(value)) return value.map(replaceManifestDirectory);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceManifestDirectory(item)]));
    return value;
  };
  const resolved = replaceManifestDirectory(structuredClone(manifest));
  for (const task of resolved.tasks || []) {
    for (const field of ["base_dir", "oracle_dir"]) {
      if (typeof task[field] === "string" && !path.isAbsolute(task[field])) task[field] = path.resolve(base, task[field]);
    }
    if (Array.isArray(task.grader?.artifacts)) {
      task.grader.artifacts = task.grader.artifacts.map((artifact) => path.isAbsolute(artifact) ? artifact : path.resolve(base, artifact));
    }
  }
  return resolved;
}

async function loadCampaign(rootInput) {
  const root = path.resolve(rootInput);
  const file = path.join(root, FROZEN_MANIFEST);
  const frozen = await readJson(file);
  const verdict = verifyFrozenManifest(frozen);
  if (!verdict.valid) throw new Error(`Invalid frozen campaign manifest:\n- ${verdict.errors.join("\n- ")}`);
  return { root, frozen, manifest: frozen.manifest, manifest_file: file };
}

function expand(value, workspace) {
  return String(value).replaceAll("{workspace}", workspace);
}

async function terminateProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await new Promise((resolve) => setTimeout(resolve, 750));
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

function appendCapped(current, chunk) {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  const next = current + chunk.toString();
  return next.length > MAX_CAPTURE_BYTES ? `${next.slice(0, MAX_CAPTURE_BYTES)}\n[TRUNCATED]` : next;
}

async function resolveCommand(command) {
  if (process.platform !== "win32" || path.isAbsolute(command) || /[\\/]/.test(command)) {
    return { executable: command, prefix_args: [] };
  }
  const directories = String(process.env.PATH || "")
    .split(path.delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (command.toLowerCase() === "codex") {
    for (const directory of directories) {
      const shim = path.join(directory, "codex.cmd");
      const launcher = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (await exists(shim) && await exists(launcher)) return { executable: process.execPath, prefix_args: [launcher] };
    }
  }
  const explicitExtension = path.extname(command) !== "";
  const nativeNames = explicitExtension ? [command] : [`${command}.exe`, `${command}.com`];
  for (const directory of directories) {
    for (const name of nativeNames) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return { executable: candidate, prefix_args: [] };
    }
  }
  if (!explicitExtension) {
    for (const directory of directories) {
      if (await exists(path.join(directory, `${command}.cmd`))) {
        throw new Error(`command ${command} resolves only to a .cmd shim; configure a native executable path`);
      }
    }
  }
  return { executable: command, prefix_args: [] };
}

async function runProcess(command, args, options = {}) {
  const resolution = await resolveCommand(command);
  const processArgs = [...resolution.prefix_args, ...args];
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    const child = spawn(resolution.executable, processArgs, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { stdout = appendCapped(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendCapped(stderr, chunk); });
    child.on("error", (error) => { spawnError = error; });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    const timer = setTimeout(async () => {
      timedOut = true;
      try { await terminateProcessTree(child); } catch (error) { stderr = appendCapped(stderr, `\ntermination error: ${error.message}`); }
    }, options.timeout_ms || 120_000);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: resolution.executable,
        args: processArgs,
        code: code ?? (spawnError ? -1 : 0),
        signal: signal || null,
        timed_out: timedOut,
        spawn_error: spawnError ? spawnError.message : null,
        stdout: options.redact_output === false ? stdout : redactSensitiveText(stdout),
        stderr: options.redact_output === false ? stderr : redactSensitiveText(stderr),
        duration_ns: String(process.hrtime.bigint() - started),
      });
    });
  });
}

function workspaceProcessEnvironment(workspace) {
  const existingCount = Number(process.env.GIT_CONFIG_COUNT || 0);
  if (!Number.isSafeInteger(existingCount) || existingCount < 0) throw new Error("GIT_CONFIG_COUNT must be a non-negative integer");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: String(existingCount + 1),
    [`GIT_CONFIG_KEY_${existingCount}`]: "safe.directory",
    [`GIT_CONFIG_VALUE_${existingCount}`]: workspace,
  };
}

async function collectToolchain(manifest) {
  const config = manifest.execution?.codex || {};
  const configuredCommand = config.command || "codex";
  const resolution = await resolveCommand(configuredCommand);
  let runnerVersion = null;
  if (config.mode === "raw-jsonl") runnerVersion = `raw-jsonl via Node ${process.version}`;
  else {
    const version = await runProcess(configuredCommand, ["--version"], { timeout_ms: 15_000 });
    if (version.code !== 0 || version.timed_out || version.spawn_error) {
      throw new Error(`cannot identify campaign model runner: ${version.stderr || version.spawn_error || version.code}`);
    }
    runnerVersion = version.stdout.trim();
  }
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runner: {
      mode: config.mode || "codex-exec",
      command: configuredCommand,
      resolved_command: resolution.executable,
      launcher_args_sha256: sha256Value(resolution.prefix_args),
      version: runnerVersion,
      configuration_sha256: sha256Value({
        prefix_args: config.prefix_args || [],
        extra_args: config.extra_args || [],
        model: config.model || null,
        reasoning_effort: config.reasoning_effort || null,
        windows_sandbox: config.windows_sandbox || null,
        approval: config.approval || "never",
        sandbox: config.sandbox || "workspace-write",
      }),
    },
  };
}

async function runCommandSpec(spec, workspace, timeoutMs) {
  if (!spec || typeof spec.command !== "string" || !spec.command) throw new Error("command spec requires command");
  const args = (spec.args || []).map((item) => expand(item, workspace));
  const cwd = spec.cwd ? path.resolve(expand(spec.cwd, workspace)) : workspace;
  const result = await runProcess(expand(spec.command, workspace), args, { cwd, timeout_ms: spec.timeout_ms || timeoutMs });
  return {
    id: spec.id || "unnamed",
    command: result.command,
    args: result.args,
    code: result.code,
    signal: result.signal,
    timed_out: result.timed_out,
    spawn_error: result.spawn_error,
    duration_ns: result.duration_ns,
    stdout: result.stdout,
    stderr: result.stderr,
    passed: result.code === 0 && !result.timed_out && !result.spawn_error,
  };
}

async function copyWorkspace(source, destination, overlay = null) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  if (overlay) await fs.cp(overlay, destination, { recursive: true, force: true, errorOnExist: false });
}

async function gradeWorkspace(task, workspace, timeoutMs) {
  const visible = [];
  for (const check of task.visible_checks || []) visible.push(await runCommandSpec(check, workspace, timeoutMs));
  const grader = await runCommandSpec(task.grader, workspace, timeoutMs);
  return {
    visible,
    grader,
    passed: visible.every((check) => check.passed) && grader.passed,
  };
}

function planRuns(frozen) {
  const manifest = frozen.manifest;
  const runs = [];
  if (!Array.isArray(manifest.arms) || manifest.arms.length === 0) throw new Error("campaign requires at least one arm");
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw new Error("campaign requires at least one task");
  const armIds = new Set();
  for (const arm of manifest.arms) {
    if (typeof arm.id !== "string" || !arm.id.trim()) throw new Error("campaign arm requires a non-empty id");
    if (armIds.has(arm.id)) throw new Error(`duplicate campaign arm id: ${arm.id}`);
    armIds.add(arm.id);
  }
  const taskIds = new Set();
  for (const task of manifest.tasks) {
    if (typeof task.id !== "string" || !task.id.trim()) throw new Error("campaign task requires a non-empty id");
    if (taskIds.has(task.id)) throw new Error(`duplicate campaign task id: ${task.id}`);
    taskIds.add(task.id);
  }
  const epochs = Number(manifest.epochs || 1);
  const primaryEpochs = Number(manifest.primary_epochs ?? epochs);
  if (!Number.isSafeInteger(epochs) || epochs < 1) throw new Error("campaign epochs must be a positive integer");
  if (!Number.isSafeInteger(primaryEpochs) || primaryEpochs < 1 || primaryEpochs > epochs) {
    throw new Error("campaign primary_epochs must be an integer between 1 and epochs");
  }
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    for (let taskIndex = 0; taskIndex < manifest.tasks.length; taskIndex += 1) {
      const task = manifest.tasks[taskIndex];
      const arms = ((taskIndex + epoch) % 2 === 0 ? [...manifest.arms] : [...manifest.arms].reverse());
      for (const arm of arms) {
        const runKey = sha256Value({ manifest_sha256: frozen.manifest_sha256, task_id: task.id, arm_id: arm.id, epoch });
        runs.push({
          run_key: runKey,
          task_id: task.id,
          arm_id: arm.id,
          epoch,
          partition: epoch <= primaryEpochs ? "primary" : "reliability",
        });
      }
    }
  }
  if (new Set(runs.map((run) => run.run_key)).size !== runs.length) throw new Error("campaign run keys are not unique");
  return runs;
}

async function initialize(args) {
  if (!args.manifest || !args.root) throw new Error("init requires --manifest and --root");
  const manifestPath = path.resolve(String(args.manifest));
  const root = path.resolve(String(args.root));
  const source = resolveManifestPaths(await readJson(manifestPath), manifestPath);
  const frozen = freezeCampaignManifest(source);
  const frozenPath = path.join(root, FROZEN_MANIFEST);
  if (await exists(frozenPath)) {
    const current = await readJson(frozenPath);
    if (current.manifest_sha256 !== frozen.manifest_sha256) throw new Error("campaign root is already bound to a different manifest");
  } else {
    await fs.mkdir(root, { recursive: true });
    await writeJsonAtomic(frozenPath, frozen);
    await appendLedgerEvent({
      ledger_dir: path.join(root, CAMPAIGN_LEDGER),
      campaign_id: source.campaign_id,
      ledger_kind: "campaign",
      event_type: "campaign_created",
      state_after: "support_active",
      payload: { manifest_sha256: frozen.manifest_sha256 },
    });
    await appendLedgerEvent({
      ledger_dir: path.join(root, CAMPAIGN_LEDGER),
      campaign_id: source.campaign_id,
      ledger_kind: "campaign",
      event_type: "manifest_frozen",
      state_after: "idle",
      payload: { manifest_sha256: frozen.manifest_sha256, planned_runs: planRuns(frozen).length },
    });
  }
  return { campaign_id: source.campaign_id, root, manifest_sha256: frozen.manifest_sha256, planned_runs: planRuns(frozen).length };
}

async function preflight(args) {
  const campaign = await loadCampaign(args.root);
  const report = {
    schema_version: 2,
    campaign_id: campaign.manifest.campaign_id,
    manifest_sha256: campaign.frozen.manifest_sha256,
    generated_at: new Date().toISOString(),
    toolchain: await collectToolchain(campaign.manifest),
    tasks: [],
  };
  await appendLedgerEvent({
    ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "campaign",
    event_type: "preflight_started",
    state_after: "support_active",
    payload: {},
  });
  const timeoutMs = Number(campaign.manifest.preflight_timeout_ms || campaign.manifest.execution?.timeout_ms || 120_000);
  for (const task of campaign.manifest.tasks) {
    const taskRoot = path.join(campaign.root, "preflight", task.id);
    const noOpWorkspace = path.join(taskRoot, "no-op");
    await copyWorkspace(task.base_dir, noOpWorkspace);
    const noOpVisible = [];
    for (const check of task.visible_checks || []) noOpVisible.push(await runCommandSpec(check, noOpWorkspace, timeoutMs));
    const noOpTarget = await runCommandSpec(task.grader, noOpWorkspace, timeoutMs);
    const oracle = [];
    const repetitions = Number(task.oracle_repetitions || campaign.manifest.oracle_repetitions || 3);
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const workspace = path.join(taskRoot, `oracle-${repetition}`);
      await copyWorkspace(task.base_dir, workspace, task.oracle_dir);
      const result = await gradeWorkspace(task, workspace, timeoutMs);
      oracle.push({ repetition, ...result });
    }
    const noOp = {
      visible: noOpVisible,
      target: noOpTarget,
      visible_passed: noOpVisible.every((check) => check.passed),
      target_failed: !noOpTarget.passed,
    };
    const classification = noOp.visible_passed && noOp.target_failed && oracle.every((trial) => trial.passed) ? "VALID_TASK" : "INVALID_TASK";
    report.tasks.push({
      id: task.id,
      classification,
      no_op: noOp,
      oracle,
      base_sha256: await hashDirectory(task.base_dir),
      oracle_sha256: await hashDirectory(task.oracle_dir),
      grader_artifacts_sha256: await hashGraderArtifacts(task),
    });
  }
  report.valid = report.tasks.every((task) => task.classification === "VALID_TASK");
  await writeJsonAtomic(path.join(campaign.root, PREFLIGHT_REPORT), report);
  await appendLedgerEvent({
    ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "campaign",
    event_type: "preflight_completed",
    state_after: "idle",
    payload: { report_sha256: sha256Value(report), valid: report.valid },
  });
  return report;
}

async function hashDirectory(root) {
  const records = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) records.push({ path: relative, sha256: sha256Value(await fs.readFile(full)) });
      else records.push({ path: relative, kind: "unsupported" });
    }
  }
  await walk(root);
  return sha256Value(records);
}

async function hashGraderArtifacts(task) {
  if (!task.grader || !Array.isArray(task.grader.artifacts)) {
    throw new Error(task.id + ": grader artifacts must be declared, using an empty array only for a fully inline grader");
  }
  const records = [];
  for (const artifact of task.grader.artifacts) {
    if (typeof artifact !== "string" || !artifact || artifact.includes("{workspace}")) {
      throw new Error(task.id + ": grader artifact paths must be non-empty and independent of the candidate workspace");
    }
    const metadata = await fs.lstat(artifact);
    if (metadata.isSymbolicLink()) throw new Error(task.id + ": grader artifacts cannot be symbolic links");
    if (metadata.isDirectory()) records.push({ artifact, kind: "directory", sha256: await hashDirectory(artifact) });
    else if (metadata.isFile()) records.push({ artifact, kind: "file", sha256: sha256Value(await fs.readFile(artifact)) });
    else throw new Error(task.id + ": grader artifact must be a regular file or directory");
  }
  return sha256Value(records);
}

async function validatePreflightBindings(campaign, report, campaignEvents = null) {
  const errors = [];
  if (![1, 2].includes(report.schema_version)) errors.push("preflight report schema is unsupported");
  if (report.campaign_id !== campaign.manifest.campaign_id) errors.push("preflight campaign identity mismatch");
  if (report.manifest_sha256 !== campaign.frozen.manifest_sha256) errors.push("preflight manifest hash mismatch");
  if (report.valid !== true) errors.push("preflight report is invalid");
  if (sha256Value(report.toolchain || null) !== sha256Value(await collectToolchain(campaign.manifest))) errors.push("preflight toolchain binding mismatch");
  const records = new Map();
  for (const task of report.tasks || []) {
    if (records.has(task.id)) errors.push(`duplicate preflight task: ${task.id}`);
    else records.set(task.id, task);
  }
  for (const task of campaign.manifest.tasks) {
    const record = records.get(task.id);
    if (!record) {
      errors.push(`preflight task is missing: ${task.id}`);
      continue;
    }
   if (await hashDirectory(task.base_dir) !== record.base_sha256) errors.push(`${task.id}: preflight base hash mismatch`);
   if (await hashDirectory(task.oracle_dir) !== record.oracle_sha256) errors.push(`${task.id}: preflight oracle hash mismatch`);
    if (report.schema_version >= 2 && await hashGraderArtifacts(task) !== record.grader_artifacts_sha256) {
      errors.push(`${task.id}: preflight grader artifact hash mismatch`);
    }
   records.delete(task.id);
  }
  for (const unexpected of records.keys()) errors.push(`unexpected preflight task: ${unexpected}`);
  let events = campaignEvents;
  if (!events) events = (await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER))).events;
  const receipt = events.filter((event) => event.event_type === "preflight_completed").at(-1);
  if (!receipt) errors.push("preflight completion receipt is missing");
  else if (receipt.payload?.report_sha256 !== sha256Value(report)) errors.push("preflight report receipt hash mismatch");
  return errors;
}

async function assertCurrentTaskBinding(task, record) {
  if (!record) throw new Error(`preflight task is missing: ${task.id}`);
 if (await hashDirectory(task.base_dir) !== record.base_sha256) throw new Error(`${task.id}: preflight base hash mismatch`);
 if (await hashDirectory(task.oracle_dir) !== record.oracle_sha256) throw new Error(`${task.id}: preflight oracle hash mismatch`);
  if (record.grader_artifacts_sha256 && await hashGraderArtifacts(task) !== record.grader_artifacts_sha256) {
    throw new Error(`${task.id}: preflight grader artifact hash mismatch`);
  }
}

async function initializeWorkspaceGit(workspace, timeoutMs) {
  const commands = [
    ["init", "-q"],
    ["config", "user.name", "Vision Campaign"],
    ["config", "user.email", "vision-campaign@invalid.local"],
    ["add", "-A"],
    ["commit", "-q", "--allow-empty", "-m", "sealed campaign baseline"],
  ];
  for (const args of commands) {
    const result = await runProcess("git", args, { cwd: workspace, timeout_ms: timeoutMs });
    if (result.code !== 0 || result.timed_out || result.spawn_error) {
      throw new Error(`cannot initialize sealed git baseline: git ${args.join(" ")} (${result.stderr || result.spawn_error || result.code})`);
    }
  }
}

function codexInvocation(manifest, workspace) {
  const config = manifest.execution?.codex || {};
  const command = config.command || "codex";
  const prefix = (config.prefix_args || []).map(String);
  if (config.mode === "raw-jsonl") return { command, args: prefix };
  if (config.windows_sandbox && !["elevated", "unelevated"].includes(config.windows_sandbox)) {
    throw new Error("codex windows_sandbox must be elevated or unelevated");
  }
  const args = [
    ...prefix,
    ...(config.model ? ["-m", String(config.model)] : []),
    ...(config.reasoning_effort ? ["-c", `model_reasoning_effort=${JSON.stringify(String(config.reasoning_effort))}`] : []),
    ...(process.platform === "win32" && config.windows_sandbox ? ["-c", `windows.sandbox=${JSON.stringify(config.windows_sandbox)}`] : []),
    "-a", config.approval || "never",
    "-s", config.sandbox || "workspace-write",
    "-C", workspace,
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    ...(config.extra_args || []).map(String),
    "-",
  ];
  return { command, args };
}

function promptFor(task, arm) {
  return `${arm.prompt_prefix || ""}\n\nGoal:\n${task.prompt}\n\nWork only inside this repository. Verify the observable behavior before reporting completion.\n`;
}

async function attemptIsTerminal(attemptDir) {
  const outcomePath = path.join(attemptDir, "outcome.json");
  if (!(await exists(outcomePath))) return false;
  const ledger = await verifyLedger(path.join(attemptDir, "events"));
  return ledger.valid && ledger.events.at(-1)?.event_type === "attempt_completed";
}

async function runAttempt(campaign, planned, taskBinding) {
  const task = campaign.manifest.tasks.find((candidate) => candidate.id === planned.task_id);
  const arm = campaign.manifest.arms.find((candidate) => candidate.id === planned.arm_id);
  const attemptDir = path.join(campaign.root, ATTEMPTS_DIR, planned.run_key);
  const ledgerDir = path.join(attemptDir, "events");
  const workspace = path.join(attemptDir, "workspace");
  await fs.mkdir(attemptDir, { recursive: true });
  await appendLedgerEvent({
    ledger_dir: ledgerDir,
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "attempt",
    event_type: "attempt_created",
    state_after: "setup_active",
    scope: planned,
    payload: {
     manifest_sha256: campaign.frozen.manifest_sha256,
     base_sha256: taskBinding.base_sha256,
     oracle_sha256: taskBinding.oracle_sha256,
      grader_artifacts_sha256: taskBinding.grader_artifacts_sha256 || null,
   },
  });
  let outcome;
  try {
    await copyWorkspace(task.base_dir, workspace);
    await initializeWorkspaceGit(workspace, Number(campaign.manifest.setup_timeout_ms || 120_000));
    await appendLedgerEvent({
      ledger_dir: ledgerDir,
      campaign_id: campaign.manifest.campaign_id,
      ledger_kind: "attempt",
      event_type: "model_started",
      state_after: "model_inflight",
      scope: planned,
      payload: { prompt_sha256: sha256Value(promptFor(task, arm)), arm_id: arm.id },
    });
    const invocation = codexInvocation(campaign.manifest, workspace);
    const heartbeatMs = Number(campaign.manifest.heartbeat_ms || 15_000);
    let heartbeatPending = Promise.resolve();
    const heartbeat = setInterval(() => {
      heartbeatPending = heartbeatPending.then(() => appendLedgerEvent({
        ledger_dir: ledgerDir,
        campaign_id: campaign.manifest.campaign_id,
        ledger_kind: "attempt",
        event_type: "heartbeat",
        state_after: "model_inflight",
        scope: planned,
        payload: {},
      })).catch(() => {});
    }, heartbeatMs);
    let processResult;
    try {
      processResult = await runProcess(invocation.command, invocation.args, {
        cwd: workspace,
        env: workspaceProcessEnvironment(workspace),
        stdin: promptFor(task, arm),
        timeout_ms: Number(campaign.manifest.execution?.timeout_ms || 1_200_000),
        redact_output: false,
      });
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
    }
    const parsed = parseCodexJsonl({
      attempt_id: planned.run_key,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      exit_code: processResult.code,
     timed_out: processResult.timed_out,
     signal: processResult.signal,
   });
    const durableTrace = serializeRedactedCodexJsonl(parsed.events);
    const durableStderr = parsed.stderr;
    await fs.writeFile(path.join(attemptDir, "codex.jsonl"), durableTrace, "utf8");
    await fs.writeFile(path.join(attemptDir, "codex.stderr.txt"), durableStderr, "utf8");
   await writeJsonAtomic(path.join(attemptDir, "codex-parsed.json"), parsed);
    await appendLedgerEvent({
      ledger_dir: ledgerDir,
      campaign_id: campaign.manifest.campaign_id,
      ledger_kind: "attempt",
      event_type: "model_completed",
      state_after: "verifier_inflight",
     scope: planned,
     resource_delta: parsed.usage || {},
      payload: {
        terminal: parsed.terminal,
        parsed_sha256: sha256Value(parsed),
        trace_sha256: sha256Value(durableTrace),
        stderr_sha256: sha256Value(durableStderr),
      },
    });
    const verifier = await gradeWorkspace(task, workspace, Number(campaign.manifest.verifier_timeout_ms || 120_000));
    await writeJsonAtomic(path.join(attemptDir, "verifier.json"), verifier);
    await appendLedgerEvent({
      ledger_dir: ledgerDir,
      campaign_id: campaign.manifest.campaign_id,
      ledger_kind: "attempt",
      event_type: "verifier_completed",
      state_after: "grading_inflight",
      scope: planned,
      payload: { passed: verifier.passed, verifier_sha256: sha256Value(verifier) },
    });
    let classification = "VALID_FAIL";
    if (processResult.spawn_error || ["instrumentation_failure", "protocol_incomplete"].includes(parsed.terminal.classification)) {
      classification = "INCONCLUSIVE_INFRA";
    }
    else if (parsed.terminal.classification === "success" && verifier.passed) classification = "VALID_PASS";
    const toolFailureCount = parsed.tool_outcomes.filter((tool) => tool.outcome === "failed" || (tool.exit_code !== null && tool.exit_code !== 0)).length;
    const verifierDurationNs = [...verifier.visible, verifier.grader]
      .reduce((total, check) => total + BigInt(check.duration_ns || "0"), 0n);
    outcome = {
      schema_version: 1,
      ...planned,
      classification,
      model_terminal: parsed.terminal,
      usage: parsed.usage,
      verifier,
      execution: {
        model_duration_ns: processResult.duration_ns,
        verifier_duration_ns: String(verifierDurationNs),
        tool_failure_count: toolFailureCount,
        pass_quality: classification !== "VALID_PASS" ? null : toolFailureCount === 0 ? "clean" : "retry-only",
      },
     task_binding: {
       base_sha256: taskBinding.base_sha256,
       oracle_sha256: taskBinding.oracle_sha256,
        grader_artifacts_sha256: taskBinding.grader_artifacts_sha256 || null,
     },
      candidate_sha256: await hashDirectory(workspace),
      completed_at: new Date().toISOString(),
    };
  } catch (error) {
    outcome = {
      schema_version: 1,
      ...planned,
      classification: "INCONCLUSIVE_INFRA",
      error: redactSensitiveText(error.stack || error.message),
      completed_at: new Date().toISOString(),
    };
  }
  await writeJsonAtomic(path.join(attemptDir, "outcome.json"), outcome);
  await appendLedgerEvent({
    ledger_dir: ledgerDir,
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "attempt",
    event_type: "attempt_completed",
    state_after: "terminal",
    scope: planned,
    payload: { classification: outcome.classification, outcome_sha256: sha256Value(outcome) },
  });
  await appendLedgerEvent({
    ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "campaign",
    event_type: "receipt_accepted",
    state_after: "support_active",
    scope: planned,
    payload: { classification: outcome.classification, outcome_sha256: sha256Value(outcome) },
  });
  return outcome;
}

async function isCancelled(campaign) {
  const ledger = await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER));
  return ledger.events.some((event) => event.event_type === "cancel_requested");
}

function durationTargetNs(manifest) {
  if (!Object.hasOwn(manifest, "stop_after_eligible_hours")) return null;
  const hours = Number(manifest.stop_after_eligible_hours);
  if (!Number.isFinite(hours) || hours < 0) throw new Error("campaign stop_after_eligible_hours must be a non-negative number");
  return BigInt(Math.ceil(hours * 3_600_000_000_000));
}

function readAdmissions(events, plannedByKey, errors = null) {
  const admitted = new Set();
  for (const event of events.filter((candidate) => candidate.event_type === "run_admitted")) {
    const runKey = event.scope?.run_key;
    const planned = plannedByKey.get(runKey);
    if (!planned) {
      errors?.push(`unexpected admitted run: ${runKey || "missing run_key"}`);
      continue;
    }
    if (admitted.has(runKey)) {
      errors?.push(`duplicate admission for ${runKey}`);
      continue;
    }
    for (const field of ["task_id", "arm_id", "epoch", "partition"]) {
      if (event.scope?.[field] !== planned[field]) errors?.push(`${runKey}: admission ${field} mismatch`);
    }
    admitted.add(runKey);
  }
  return admitted;
}

async function accountingSnapshot(campaign, planned) {
  const campaignLedger = await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER));
  if (!campaignLedger.valid) throw new Error(`Invalid campaign ledger:\n- ${campaignLedger.errors.join("\n- ")}`);
  const ledgers = [campaignLedger.events];
  for (const run of planned) {
    const attemptLedger = await verifyLedger(path.join(campaign.root, ATTEMPTS_DIR, run.run_key, "events"));
    if (!attemptLedger.valid) throw new Error(`Invalid attempt ledger ${run.run_key}:\n- ${attemptLedger.errors.join("\n- ")}`);
    if (attemptLedger.events.length) ledgers.push(attemptLedger.events);
  }
  return replayCampaignAccounting(ledgers, {
    max_credible_gap_ns: String(BigInt(Number(campaign.manifest.max_credible_gap_ms || 60_000)) * 1_000_000n),
  });
}

async function executeWithLease(campaign) {
  const preflightReport = await readJson(path.join(campaign.root, PREFLIGHT_REPORT));
  const preflightErrors = await validatePreflightBindings(campaign, preflightReport);
  if (preflightErrors.length) throw new Error(`campaign preflight is missing, stale, or invalid:\n- ${preflightErrors.join("\n- ")}`);
  const planned = planRuns(campaign.frozen);
  const plannedByKey = new Map(planned.map((run) => [run.run_key, run]));
  const campaignLedger = await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER));
  if (!campaignLedger.valid) throw new Error(`Invalid campaign ledger:\n- ${campaignLedger.errors.join("\n- ")}`);
  const admissionErrors = [];
  const admitted = readAdmissions(campaignLedger.events, plannedByKey, admissionErrors);
  if (admissionErrors.length) throw new Error(`Invalid campaign admissions:\n- ${admissionErrors.join("\n- ")}`);
  const terminal = new Set();
  for (const run of planned) {
    if (await attemptIsTerminal(path.join(campaign.root, ATTEMPTS_DIR, run.run_key))) terminal.add(run.run_key);
  }
  for (const runKey of terminal) {
    if (!admitted.has(runKey)) throw new Error(`terminal attempt was never admitted: ${runKey}`);
  }
  const primary = planned.filter((run) => run.partition === "primary");
  const targetNs = durationTargetNs(campaign.manifest);
  const preflightByTask = new Map(preflightReport.tasks.map((task) => [task.id, task]));
  const attempts = [];
  let reason = "planned_exhausted";
  for (const run of planned) {
    if (await isCancelled(campaign)) {
      reason = "cancel_requested";
      break;
    }
    if (terminal.has(run.run_key)) continue;
    const task = campaign.manifest.tasks.find((candidate) => candidate.id === run.task_id);
    await assertCurrentTaskBinding(task, preflightByTask.get(run.task_id));
    if (!admitted.has(run.run_key)) {
      const primaryComplete = primary.every((candidate) => terminal.has(candidate.run_key));
      if (run.partition === "reliability" && primaryComplete && targetNs !== null) {
        const accounting = await accountingSnapshot(campaign, planned);
        if (BigInt(accounting.eligible_core_active_ns) >= targetNs) {
          reason = "duration_met";
          break;
        }
      }
      await appendLedgerEvent({
        ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
        campaign_id: campaign.manifest.campaign_id,
        ledger_kind: "campaign",
        event_type: "run_admitted",
        state_after: "support_active",
        scope: run,
        payload: { manifest_sha256: campaign.frozen.manifest_sha256 },
      });
      admitted.add(run.run_key);
    }
    attempts.push(await runAttempt(campaign, run, preflightByTask.get(run.task_id)));
    terminal.add(run.run_key);
  }
  await appendLedgerEvent({
    ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
    campaign_id: campaign.manifest.campaign_id,
    ledger_kind: "campaign",
    event_type: "scheduling_stopped",
    state_after: "idle",
    payload: {
      reason,
      new_attempts: attempts.length,
      admitted_attempts: admitted.size,
      terminal_attempts: terminal.size,
      cancel_requested: await isCancelled(campaign),
    },
  });
  return { campaign_id: campaign.manifest.campaign_id, stopping_reason: reason, attempts };
}

async function execute(args) {
  const campaign = await loadCampaign(args.root);
  const lease = await acquireRunnerLease(campaign);
  try {
    return await executeWithLease(campaign);
  } finally {
    await lease.release();
  }
}

async function verifyCampaign(args) {
  const campaign = await loadCampaign(args.root);
  const errors = [];
  const warnings = [];
  const limitations = [];
  let sawLegacyTraceBinding = false;
  const campaignLedger = await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER));
  if (!campaignLedger.valid) errors.push(...campaignLedger.errors.map((error) => `campaign ledger: ${error}`));
  const preflightPath = path.join(campaign.root, PREFLIGHT_REPORT);
  let preflightReport = null;
  if (!(await exists(preflightPath))) errors.push("preflight report is missing");
  else {
    preflightReport = await readJson(preflightPath);
    errors.push(...await validatePreflightBindings(campaign, preflightReport, campaignLedger.events));
    if (preflightReport.schema_version === 1) limitations.push("legacy preflight schema 1 does not bind grader artifacts");
  }
  const preflightByTask = new Map((preflightReport?.tasks || []).map((task) => [task.id, task]));
  const planned = planRuns(campaign.frozen);
  const plannedByKey = new Map(planned.map((run) => [run.run_key, run]));
  const primary = planned.filter((run) => run.partition === "primary");
  const admitted = readAdmissions(campaignLedger.events, plannedByKey, errors);
  const admissionSequence = new Map();
  const receipts = new Map();
  for (const event of campaignLedger.events) {
    if (event.event_type === "run_admitted" && plannedByKey.has(event.scope?.run_key) && !admissionSequence.has(event.scope.run_key)) {
      admissionSequence.set(event.scope.run_key, event.seq);
    }
    if (event.event_type === "receipt_accepted") {
      const runKey = event.scope?.run_key;
      if (!plannedByKey.has(runKey)) errors.push(`unexpected accepted receipt: ${runKey || "missing run_key"}`);
      else if (!admissionSequence.has(runKey) || admissionSequence.get(runKey) >= event.seq) errors.push(`${runKey}: receipt precedes admission`);
      if (receipts.has(runKey)) errors.push(`duplicate accepted receipt for ${runKey}`);
      else receipts.set(runKey, event);
    }
  }
  const outcomes = {};
  const completedOutcomes = [];
  const ledgers = [campaignLedger.events];
  const terminalKeys = new Set();
  const partialAttempts = [];
  const attemptsRoot = path.join(campaign.root, ATTEMPTS_DIR);
  if (await exists(attemptsRoot)) {
    for (const entry of await fs.readdir(attemptsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !plannedByKey.has(entry.name)) errors.push(`unexpected attempt directory: ${entry.name}`);
    }
  }
  for (const run of planned) {
    const attemptDir = path.join(campaign.root, ATTEMPTS_DIR, run.run_key);
    const outcomePath = path.join(attemptDir, "outcome.json");
    const attemptLedger = await verifyLedger(path.join(attemptDir, "events"));
    if (attemptLedger.events.length) ledgers.push(attemptLedger.events);
    if (!attemptLedger.valid) {
      errors.push(...attemptLedger.errors.map((error) => `${run.run_key}: ${error}`));
      continue;
    }
    if (!(await exists(outcomePath))) {
      const lastPartial = attemptLedger.events.at(-1);
      if (lastPartial) {
        partialAttempts.push({
          run_key: run.run_key,
          task_id: run.task_id,
          arm_id: run.arm_id,
          epoch: run.epoch,
          last_event_type: lastPartial.event_type,
          state_after: lastPartial.state_after,
        });
        errors.push(`${run.run_key}: partial admitted attempt ends at ${lastPartial.event_type}`);
      }
      continue;
    }
    if (!admitted.has(run.run_key)) errors.push(`${run.run_key}: terminal outcome was never admitted`);
    const last = attemptLedger.events.at(-1);
    if (last?.event_type !== "attempt_completed") {
      errors.push(`${run.run_key}: missing terminal attempt receipt`);
      continue;
    }
    const outcome = await readJson(outcomePath);
    if (sha256Value(outcome) !== last.payload?.outcome_sha256) {
      errors.push(`${run.run_key}: outcome hash mismatch`);
      continue;
    }
    if (outcome.run_key !== run.run_key || outcome.task_id !== run.task_id || outcome.arm_id !== run.arm_id || outcome.epoch !== run.epoch || outcome.partition !== run.partition) {
      errors.push(`${run.run_key}: outcome identity mismatch`);
      continue;
    }
    const binding = preflightByTask.get(run.task_id);
    const attemptCreated = attemptLedger.events.find((event) => event.event_type === "attempt_created");
    if (!binding || attemptCreated?.payload?.base_sha256 !== binding.base_sha256 || attemptCreated?.payload?.oracle_sha256 !== binding.oracle_sha256) {
      errors.push(`${run.run_key}: attempt task binding mismatch`);
    }
    if (!binding || outcome.task_binding?.base_sha256 !== binding.base_sha256 || outcome.task_binding?.oracle_sha256 !== binding.oracle_sha256) {
      errors.push(`${run.run_key}: outcome task binding mismatch`);
    }
    if (binding?.grader_artifacts_sha256) {
      if (attemptCreated?.payload?.grader_artifacts_sha256 !== binding.grader_artifacts_sha256) {
        errors.push(`${run.run_key}: attempt grader binding mismatch`);
      }
      if (outcome.task_binding?.grader_artifacts_sha256 !== binding.grader_artifacts_sha256) {
        errors.push(`${run.run_key}: outcome grader binding mismatch`);
      }
    }
    const receipt = receipts.get(run.run_key);
    if (!receipt) errors.push(`${run.run_key}: campaign receipt is missing`);
    else if (receipt.payload?.outcome_sha256 !== last.payload?.outcome_sha256) errors.push(`${run.run_key}: campaign receipt hash mismatch`);
    if (outcome.candidate_sha256) {
      const actualCandidate = await hashDirectory(path.join(attemptDir, "workspace"));
      if (actualCandidate !== outcome.candidate_sha256) errors.push(`${run.run_key}: candidate hash mismatch`);
    }
    const parsedPath = path.join(attemptDir, "codex-parsed.json");
    const modelReceipt = attemptLedger.events.findLast((event) => event.event_type === "model_completed");
    if (modelReceipt && await exists(parsedPath)) {
      const parsed = await readJson(parsedPath);
      if (sha256Value(parsed) !== modelReceipt.payload?.parsed_sha256) errors.push(`${run.run_key}: parsed Codex trace hash mismatch`);
    } else if (outcome.classification !== "INCONCLUSIVE_INFRA") errors.push(`${run.run_key}: parsed Codex trace receipt is missing`);
    const tracePath = path.join(attemptDir, "codex.jsonl");
    const stderrPath = path.join(attemptDir, "codex.stderr.txt");
    if (modelReceipt?.payload?.trace_sha256 && modelReceipt?.payload?.stderr_sha256) {
      if (!(await exists(tracePath)) || sha256Value(await fs.readFile(tracePath, "utf8")) !== modelReceipt.payload.trace_sha256) {
        errors.push(`${run.run_key}: Codex trace hash mismatch`);
      }
      if (!(await exists(stderrPath)) || sha256Value(await fs.readFile(stderrPath, "utf8")) !== modelReceipt.payload.stderr_sha256) {
        errors.push(`${run.run_key}: Codex stderr hash mismatch`);
      }
    } else sawLegacyTraceBinding = true;
    const verifierPath = path.join(attemptDir, "verifier.json");
    const verifierReceipt = attemptLedger.events.findLast((event) => event.event_type === "verifier_completed");
    if (verifierReceipt && await exists(verifierPath)) {
      const verifier = await readJson(verifierPath);
      if (sha256Value(verifier) !== verifierReceipt.payload?.verifier_sha256 || sha256Value(verifier) !== sha256Value(outcome.verifier)) {
        errors.push(`${run.run_key}: verifier receipt hash mismatch`);
      }
    } else if (outcome.classification !== "INCONCLUSIVE_INFRA") errors.push(`${run.run_key}: verifier receipt is missing`);
    if (outcome.classification === "INCONCLUSIVE_INFRA") warnings.push(`${run.run_key}: attempt is inconclusive infrastructure evidence`);
    terminalKeys.add(run.run_key);
    completedOutcomes.push(outcome);
    outcomes[outcome.classification] = (outcomes[outcome.classification] || 0) + 1;
  }
  if (sawLegacyTraceBinding) limitations.push("legacy attempt receipts do not bind durable Codex JSONL and stderr artifacts");
  const primaryTerminal = primary.filter((run) => terminalKeys.has(run.run_key)).length;
  const admittedTerminal = [...admitted].filter((runKey) => terminalKeys.has(runKey)).length;
  if (primaryTerminal !== primary.length || admittedTerminal !== admitted.size) {
    errors.push(`planned attempts are not terminal: ${primaryTerminal}/${primary.length} primary; ${admittedTerminal}/${admitted.size} admitted`);
  }
  const accounting = replayCampaignAccounting(ledgers, {
    max_credible_gap_ns: String(BigInt(Number(campaign.manifest.max_credible_gap_ms || 60_000)) * 1_000_000n),
  });
  if (BigInt(accounting.invalid_padding_ns) > 0n) errors.push("campaign contains invalid padding intervals");
  const targetNs = durationTargetNs(campaign.manifest);
  const lastStop = campaignLedger.events.filter((event) => event.event_type === "scheduling_stopped").at(-1);
  if (targetNs === null) {
    if (admitted.size !== planned.length) errors.push(`planned runs were not all admitted: ${admitted.size}/${planned.length}`);
  } else {
    if (BigInt(accounting.eligible_core_active_ns) < targetNs) {
      errors.push(`eligible core-active duration is below manifest target of ${campaign.manifest.stop_after_eligible_hours} hours`);
    }
    if (admitted.size < planned.length && lastStop?.payload?.reason !== "duration_met") {
      errors.push("partial reliability matrix lacks a duration_met scheduling receipt");
    }
  }
  const requiredHours = Number(args["require-accounted-hours"] || 0);
  if (!Number.isFinite(requiredHours) || requiredHours < 0) errors.push("--require-accounted-hours must be a non-negative number");
  else if (requiredHours > 0) {
    const requiredNs = BigInt(Math.ceil(requiredHours * 3_600_000_000_000));
    if (BigInt(accounting.eligible_core_active_ns) < requiredNs) errors.push(`eligible core-active duration is below ${requiredHours} hours`);
  }
  const report = {
    schema_version: 1,
    campaign_id: campaign.manifest.campaign_id,
    manifest_sha256: campaign.frozen.manifest_sha256,
    valid: errors.length === 0,
    conclusive: (outcomes.INCONCLUSIVE_INFRA || 0) === 0,
    errors,
    warnings,
    limitations,
    cancel_requested: campaignLedger.events.some((event) => event.event_type === "cancel_requested"),
    stopping_reason: lastStop?.payload?.reason || null,
    attempts: {
      planned: planned.length,
      admitted: admitted.size,
      terminal: terminalKeys.size,
      partial: partialAttempts.length,
      primary_required: primary.length,
    },
    partial_attempts: partialAttempts,
    outcomes,
    calibration: buildCampaignCalibration({ manifest: campaign.manifest, outcomes: completedOutcomes, preflight: preflightReport }),
    accounting,
    generated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(campaign.root, "verification-report.json"), report);
  return report;
}

async function status(args) {
  const campaign = await loadCampaign(args.root);
  const ledger = await verifyLedger(path.join(campaign.root, CAMPAIGN_LEDGER));
  const planned = planRuns(campaign.frozen);
  const plannedByKey = new Map(planned.map((run) => [run.run_key, run]));
  const admissionErrors = [];
  const admitted = readAdmissions(ledger.events, plannedByKey, admissionErrors);
  let terminal = 0;
  let partial = 0;
  const outcomes = {};
  for (const run of planned) {
    const attemptDir = path.join(campaign.root, ATTEMPTS_DIR, run.run_key);
    const outcomePath = path.join(attemptDir, "outcome.json");
    if (!(await exists(outcomePath))) {
      const attemptLedger = await verifyLedger(path.join(attemptDir, "events"));
      if (attemptLedger.events.length) partial += 1;
      continue;
    }
    const outcome = await readJson(outcomePath);
    terminal += 1;
    outcomes[outcome.classification] = (outcomes[outcome.classification] || 0) + 1;
  }
  return {
    schema_version: 1,
    campaign_id: campaign.manifest.campaign_id,
    manifest_sha256: campaign.frozen.manifest_sha256,
    ledger_valid: ledger.valid && admissionErrors.length === 0,
    ledger_errors: [...ledger.errors, ...admissionErrors],
    cancel_requested: ledger.events.some((event) => event.event_type === "cancel_requested"),
    stopping_reason: ledger.events.filter((event) => event.event_type === "scheduling_stopped").at(-1)?.payload?.reason || null,
    attempts: {
      planned: planned.length,
      admitted: admitted.size,
      terminal,
      partial,
      primary_required: planned.filter((run) => run.partition === "primary").length,
    },
    outcomes,
  };
}

async function cancel(args) {
  const campaign = await loadCampaign(args.root);
  const reason = String(args.reason || "").trim();
  if (!reason) throw new Error("cancel requires --reason");
  if (!(await isCancelled(campaign))) {
    await appendLedgerEvent({
      ledger_dir: path.join(campaign.root, CAMPAIGN_LEDGER),
      campaign_id: campaign.manifest.campaign_id,
      ledger_kind: "campaign",
      event_type: "cancel_requested",
      state_after: "paused",
      payload: { reason },
    });
  }
  return { campaign_id: campaign.manifest.campaign_id, cancel_requested: true, reason };
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || command === "help" || args.help === true) {
    console.log(usage());
    return { exit_code: 0 };
  }
  if (!args.root && command !== "init") throw new Error(`${command} requires --root`);
  let result;
  if (command === "init") result = await initialize(args);
  else if (command === "preflight") result = await preflight(args);
  else if (command === "run" || command === "resume") result = await execute(args);
  else if (command === "verify") result = await verifyCampaign(args);
  else if (command === "status") result = await status(args);
  else if (command === "cancel") result = await cancel(args);
  else throw new Error(`Unknown command: ${command}`);
  printResult(result, args.json === true);
  if ((command === "preflight" || command === "verify") && result.valid === false) process.exitCode = 2;
  return result;
}

async function canonicalExecutablePath(value) {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

const invokedPath = process.argv[1] ? await canonicalExecutablePath(process.argv[1]) : null;
const modulePath = await canonicalExecutablePath(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error) => {
    console.error(`ERROR: ${redactSensitiveText(error.stack || error.message)}`);
    process.exitCode = 1;
  });
}
