import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(root, "plugins", "vision");

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

test("Vision ships one opt-in workflow and two focused skills", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const skill = await fs.readFile(path.join(pluginRoot, "skills", "vision", "SKILL.md"), "utf8");
  const skillMetadata = await fs.readFile(path.join(pluginRoot, "skills", "vision", "agents", "openai.yaml"), "utf8");
  const workflow = await fs.readFile(path.join(pluginRoot, "skills", "vision", "references", "workflow.md"), "utf8");
  const bootstrap = await fs.readFile(path.join(pluginRoot, "skills", "bootstrap-agents-md", "SKILL.md"), "utf8");
  const persistentService = await fs.readFile(path.join(pluginRoot, "skills", "keep-service-running", "SKILL.md"), "utf8");
  const skillEntries = (await fs.readdir(path.join(pluginRoot, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillEntries, ["bootstrap-agents-md", "keep-service-running", "vision"]);
  assert.equal(manifest.name, "vision");
  assert.equal(manifest.version, "0.6.0");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assert.match(skill, /Use only when the user explicitly asks for Vision/);
  assert.match(skill, /Do not auto-trigger for ordinary engineering work/);
  assert.match(skillMetadata, /allow_implicit_invocation: false/);
  assert.match(skill, /Optimize for the outcome, not proof that a preferred process was followed/);
  assert.match(skill, /prefer the weakest sufficient working hypothesis/i);
  assert.match(skill, /Run the checks that answer whether the change works/);
  assert.match(workflow, /Normal local evidence does not need a Vision schema/);
  assert.match(bootstrap, /Build instructions from repository evidence/);
  assert.match(bootstrap, /Do not create or update `AGENTS\.md` in a disposable one-task workspace/);
  assert.match(bootstrap, /make no change/);
  assert.match(bootstrap, /Confirm referenced paths and commands exist/);
  assert.match(bootstrap, /Avoid conflicting absolutes, mandatory planning ceremony/);
  assert.match(persistentService, /properly detached process/);
  assert.match(persistentService, /Do not auto-trigger for standard daemons with native service or daemon lifecycle controls/);
  assert.match(persistentService, /exact client path from a separate process/);
  assert.match(persistentService, /re-check both the listener and service process/);
});

test("Vision does not ship runtime hooks or repository process scaffolding", async () => {
  assert.equal(await exists(path.join(pluginRoot, "hooks", "hooks.json")), false);
  assert.equal(await exists(path.join(pluginRoot, ".mcp.json")), false);
  assert.equal(await exists(path.join(pluginRoot, "assets", "project-template")), false);
  assert.equal(await exists(path.join(pluginRoot, "scripts", "install-project.mjs")), false);
  assert.equal(await exists(path.join(pluginRoot, "scripts", "agentic.mjs")), false);
});

test("public product docs reject proof-of-process requirements", async () => {
  const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
  const verification = await fs.readFile(path.join(root, "docs", "verification-model.md"), "utf8");

  assert.match(readme, /Those systems made the model serve the framework/);
  assert.match(verification, /It is not evidence that Vision followed a prescribed process/);
  assert.match(verification, /Normal local work does not need a Vision contract/);
});
