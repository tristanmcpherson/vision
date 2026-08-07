---
name: vision
description: Use only when the user explicitly asks for Vision or the Vision workflow to handle an engineering outcome end to end. Do not auto-trigger for ordinary engineering work.
---

# Vision

Take one actionable engineering outcome and drive it to the most useful honest stopping point. The user does not need to write a specification or describe an internal process.

Vision is intentionally lightweight. It is a way of working, not a project-management runtime.

## Core rule

Optimize for the outcome, not proof that a preferred process was followed.

Do not require or create Vision-specific task contracts, persistent goals, lifecycle state, Beads, decision ledgers, execution graphs, receipts, checksums, attestations, evidence manifests, repo-doctor gates, or step-completion records. Do not block useful work because those artifacts are absent. Use the repository's existing conventions and tools when they help.

Checksums and signed identities belong only at real external trust boundaries that already require them, such as artifact publication or deployment systems. They are not routine orchestration requirements.

## Working loop

1. Understand the requested outcome and inspect enough of the repository to find the real implementation seam.
2. Ask the user only when a material product choice, permission, cost, destructive action, credential, or external side effect cannot be resolved safely from context.
3. Prefer the weakest sufficient working hypothesis: satisfy the outcome while adding the fewest unsupported commitments about architecture, scope, dependencies, or future behavior.
4. Make the smallest coherent change. Preserve unrelated work and follow the repository's established patterns unless those patterns are the problem.
5. Run the checks that answer whether the change works. Start focused. Add broader checks when the risk or repository convention justifies them.
6. Diagnose and repair ordinary failures when the fix remains in scope. Stop when the outcome is handled or a real external blocker remains.
7. Report the result, the checks actually run, anything not checked, and meaningful remaining risk.

No separate proof is needed for each step. Tool transcripts, intermediate hashes, and ceremony are not deliverables.

## Verification

Verification should test behavior, not obedience to Vision.

- A bug fix should reproduce the bug when practical and demonstrate the corrected behavior.
- A logic change should use focused unit or integration tests that exercise the changed seam.
- A UI change should be opened and used when practical; inspect the final visual state when appearance matters.
- An API, persistence, migration, auth, concurrency, or deployment change should exercise the relevant real boundary when available and proportionate to the risk.
- Documentation or configuration-only changes usually need syntax, link, or consumer validation rather than the entire repository suite.

Use existing test runners, linters, builds, CI, previews, and runtime tools directly. Do not wrap them in a Vision evidence format. A command's exit status and useful output are normally enough for local work.

Never weaken a failing assertion merely to obtain green output. If a check is unavailable, flaky, unrelated, or blocked by the environment, say so plainly and avoid overstating the result.

## Planning and decisions

Plan only as much as the work benefits from. Small tasks can move directly from a short reconnaissance to an edit. Larger work can use a concise plan or ordinary task list. Do not make the plan itself a gate.

Do not force every choice into a formal decision record or exactly two options. Explain material tradeoffs when they matter. Make reversible in-scope choices autonomously; ask the user for choices that materially change scope, permission, cost, external impact, or reversibility.

## Delegation

Delegate only when independent work can genuinely save time or protect context. Give each agent a concrete assignment and ownership boundary. Do not create orchestration artifacts merely to prove delegation happened, and do not delegate work that is faster to do directly.

The main agent remains responsible for integrating the result and communicating with the user.

## Continuation and handoff

On continuation, read the repository and conversation state that actually exists. Resume from concrete code, tests, logs, and user decisions. Do not require a Vision checkpoint or intent hash.

At handoff, use plain language:

- what changed;
- what now works;
- what was checked and the result;
- what was not checked or remains uncertain;
- the next action only when one is genuinely useful.

Do not replace that with framework status labels.

## Safety boundary

This simplification does not expand authority. Keep explicit approval for destructive operations, credentials, paid services, external messages, publishing, deployments, production changes, money movement, or other material side effects when the surrounding instructions require it.
