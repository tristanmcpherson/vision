# Vision framework

This repository packages the lightweight `vision` Codex plugin and focused opt-in skills that have a concrete product purpose. Older evaluation machinery remains research material.

## Product boundary

- `plugins/vision/skills/` is the shipped product surface. Keep every skill small, selectively triggered, and independently useful.
- `plugins/vision/.codex-plugin/plugin.json` defines the public plugin surface.
- `docs/verification-model.md` explains useful outcome evidence without Vision-specific proof ceremony.
- `evaluation/` and `proof/` are historical/research fixtures. They do not define the runtime workflow.

## Working rule

Optimize for useful software outcomes, not evidence that an agent followed a preferred sequence.

Do not add mandatory Vision contracts, goals, lifecycle files, Beads state, decision ledgers, execution graphs, receipts, checksums, attestations, or step-proof requirements. Use existing repository checks directly and keep verification proportional to the claim and risk.

Preserve real external safety controls and user approval boundaries. A deployment platform's artifact identity or signature may be necessary; a local Vision checksum chain is not.

## Verification

Run `npm test` before treating changes to the shipped plugin as complete. Add focused checks for actual executable behavior when the change includes executable behavior.

Do not run the historical browser proof or process-harness suites as product gates. They are opt-in research commands only.
