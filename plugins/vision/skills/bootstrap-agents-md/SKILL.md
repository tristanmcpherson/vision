---
name: bootstrap-agents-md
description: Create or improve concise repository-specific AGENTS.md instructions when the user explicitly asks, or when setting up a persistent repository for future agent work. Skip disposable, empty, and one-shot workspaces.
---

# Bootstrap AGENTS.md

Build instructions from repository evidence. Do not paste a generic Vision workflow into every project.

## Skip when guidance would be temporary

Do not create or update `AGENTS.md` in a disposable one-task workspace, an empty or newly generated directory, or a repository where the only available facts restate the current request. If there is no durable repository evidence that should guide future agent turns, make no change. Continue the requested task without turning its instructions into repository policy.

## Discover what belongs

1. Read every applicable `AGENTS.md` from the repository root to the target directory. Preserve useful existing rules and the precedence of more-specific files.
2. Inspect the README, package or build configuration, CI workflows, neighboring code, and contributor documentation. Identify the actual project objective, important boundaries, native commands, generated or protected paths, and established patterns.
3. Include only durable facts that should affect future agent work. Keep transient task state, personal commentary, secrets, and generic model advice out of repository instructions.

## Write the smallest useful file

Create a root `AGENTS.md` when none exists. If one exists, patch only stale, conflicting, or materially missing guidance. Add a nested `AGENTS.md` only when a subtree genuinely needs different instructions.

Use only sections supported by the repository, typically:

- what the project is trying to achieve and where the main implementation lives;
- commands for focused tests, broader checks, builds, formatting, and local runtime use;
- code, architecture, generated-file, and dirty-work conventions that are easy to violate;
- verification expectations that map to the kinds of changes this repository contains;
- material approval or safety boundaries specific to this project;
- delegation guidance only when independent work is common, naming role, ownership, expected evidence, and handoff boundary.

Prefer short direct instructions and concrete commands. Explain the reason for a surprising constraint. Reference an authoritative local document instead of copying a long specification. Avoid conflicting absolutes, mandatory planning ceremony, task ledgers, receipts, checksum chains, or rules that merely restate built-in Codex behavior.

## Check the result

Confirm referenced paths and commands exist. Run a cheap syntax or consumer check when the repository provides one. Review the final diff for invented rules, duplicated guidance, accidental secrets, and contradictions with a parent or nested `AGENTS.md`. Report what was added and any important repository fact that could not be confirmed.
