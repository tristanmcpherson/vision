# Vision for Codex

Vision is a small Codex plugin for taking an engineering outcome through implementation and useful verification. It also includes two focused opt-in skills instead of folding every useful behavior into one universal harness.

```text
$vision:vision Fix the invoice export bug.
```

That sentence is enough. Vision inspects the repository, works out the smallest coherent solution, implements it, runs checks that answer whether it works, and reports the result honestly.

Use the focused skills only when their trigger matches:

```text
$vision:bootstrap-agents-md Bootstrap useful AGENTS.md guidance for this repository.
$vision:keep-service-running Start this local server and leave it available for the next step.
```

## Recommended use

Keep Vision selective. The benchmark evidence so far favors narrow, task-relevant guidance over a broad layer applied to every Codex task.

- Use `$vision:vision` when you explicitly want Codex to own a meaningful repository outcome end to end: investigate, implement, check the behavior, repair ordinary failures, and hand back an honest result.
- Use normal Codex for quick questions, tiny edits, status checks, reviews, or work where you have already specified the exact action. Vision should not add ceremony to work that is already clear.
- Use `$vision:bootstrap-agents-md` for a persistent repository whose commands, boundaries, or conventions should survive into future tasks. Do not use it for disposable benchmark containers, empty projects, or one-off workspaces.
- Use `$vision:keep-service-running` when an ad hoc server or worker must still be reachable after the launch command or agent turn ends. Prefer a service's native manager for standard daemons, and do not use this skill merely because a command happens to run in the background.

The plugin does not auto-apply the general Vision workflow. Invoke it when its end-to-end ownership is useful. The two focused skills can trigger only for their narrow scenarios.

## Install or update

Add the public marketplace and install Vision:

```powershell
codex plugin marketplace add tristanmcpherson/vision --ref main
codex plugin add vision@vision-local
```

To pick up a later release:

```powershell
codex plugin marketplace upgrade vision-local
codex plugin add vision@vision-local
```

Start a new Codex task after installing or updating so the new skill definitions are loaded.

`bootstrap-agents-md` derives concise instructions from the repository's actual commands, conventions, and safety boundaries. It does not install a generic process template. Its design keeps the durable parts of the source guidance: project knowledge in reviewable files, higher-objective context, simple non-conflicting instructions, and explicit delegation boundaries only when delegation helps.

`keep-service-running` handles a narrower failure mode: a server that works during the agent turn but disappears before independent verification or user use. It requires a service manager or properly detached process, a separate client check, and a final listener/process check.

## What Vision does

- researches the real implementation seam;
- infers ordinary details from repository evidence;
- prefers the weakest sufficient solution instead of inventing architecture or scope;
- makes reversible in-scope decisions without routine approval pauses;
- uses existing tests, builds, linters, browsers, and runtime tools directly;
- fixes ordinary failures when the repair remains in scope;
- reports what changed, what passed, what was not checked, and meaningful remaining risk.

## What Vision no longer does

Vision does not require its own:

- versioned task contract;
- persistent goal or intent hash;
- lifecycle controller or checkpoint state;
- Beads integration;
- execution graph;
- decision ledger;
- repo-doctor gate;
- evidence schema, receipt, nonce, or checksum chain;
- signed local verifier or delivery ceremony;
- proof that each workflow step happened.

Those systems made the model serve the framework. They did not improve the software often enough to justify the friction.

Checksums, signatures, immutable artifact IDs, and deployment identities can still be useful at real external trust boundaries. Vision simply does not recreate those controls as routine local orchestration.

## Working model

```text
understand -> change -> check the behavior -> report
                 ^              |
                 |--- repair ----| when useful and in scope
```

Small work should stay small. Larger work can use a concise plan or delegation when it actually helps, but the plan is not a gate and delegation does not need a receipt.

The verification question is concrete: what evidence would tell us this change works?

- Logic changes usually need focused tests.
- Integration changes need the relevant real seam exercised.
- UI changes should be used and visually inspected when appearance matters.
- API, migration, auth, concurrency, and deployment changes deserve checks at those boundaries when available and proportionate to the risk.
- Documentation and configuration changes usually need targeted validation, not a full browser-backed proof campaign.

## Weakest sufficient solutions

Vision uses the idea from Michael Timothy Bennett's [The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest](https://arxiv.org/abs/2301.12987): prefer explanations that add no more specificity than necessary.

For software work, this means avoiding unsupported abstractions, dependencies, compatibility promises, or scope. It does not mean fewer lines of code, and it never means deleting real acceptance requirements. See [Weakest-sufficient hypothesis selection](docs/weakest-sufficient-hypothesis.md).

## Verification language

Use plain claims:

- "implemented; focused tests pass";
- "implemented; full test suite passes";
- "implemented; runtime check was unavailable";
- "diagnosed only; no fix was requested".

Do not replace those facts with framework states such as `closure-verified` or `delivered-and-verified`.

## Repository layout

- [Vision skill](plugins/vision/skills/vision/SKILL.md) - the lightweight outcome workflow.
- [Bootstrap AGENTS.md](plugins/vision/skills/bootstrap-agents-md/SKILL.md) - repository-derived agent instructions.
- [Keep Service Running](plugins/vision/skills/keep-service-running/SKILL.md) - persistent service launch and independent verification.
- [Workflow reference](plugins/vision/skills/vision/references/workflow.md) - practical intake, build, and verification guidance.
- [Verification model](docs/verification-model.md) - what useful evidence can and cannot support.
- `evaluation/` - benchmark research. It is not installed into target repositories and does not define the user workflow.
- `proof/` and the older orchestration scripts - historical experimental machinery retained temporarily for research comparison. They are not product requirements or active CI gates.

## Development

Run the active product checks:

```powershell
npm test
```

The active test verifies that the shipped plugin remains lightweight and does not reintroduce mandatory process machinery. Historical harness and campaign tests remain available under explicitly named research commands while we decide what evidence is still worth keeping.
