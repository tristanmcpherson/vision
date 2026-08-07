# Verification model

Verification exists to answer whether the software does what we now claim. It is not evidence that Vision followed a prescribed process.

## Match evidence to the claim

| Claim | Evidence that helps |
| --- | --- |
| A function or rule behaves correctly | Focused unit or property tests |
| Components work together | Existing integration tests or a direct runtime exercise |
| A UI flow works | Use the flow; inspect the final state when visual behavior matters |
| An API or persistence boundary is compatible | Exercise the real handler, serializer, datastore, or migration path |
| The repository still builds | Relevant build, typecheck, lint, or package smoke |
| A deployed target works | Existing platform checks and observability, with required approval |

A passing focused test supports a focused claim. It is not a full regression result. Source inspection supports an implementation explanation, not a runtime claim. Mocked behavior supports the mocked seam and may not establish compatibility with a real service.

## No Vision evidence protocol

Normal local work does not need a Vision contract, evidence manifest, receipt, nonce, checksum, screenshot hash, candidate fingerprint, signed grant, or lifecycle binding. Use the repository's existing test output and artifacts directly.

If CI, package publication, code signing, deployment, or another external trust boundary already requires an immutable artifact identity or signature, preserve it. That control protects a real boundary. Vision should not duplicate it locally.

## Risk still matters

Removing ceremony does not mean treating every change the same.

- Auth, tenant, security, migration, persistence, concurrency, and deployment changes deserve checks at those boundaries when available.
- Visual changes deserve a look at the actual rendered result.
- External or production actions still require the approvals, credentials, and target controls defined by the user or platform.
- A failing check should be diagnosed, not weakened to make the report look clean.

The difference is that these checks test the product. They do not test whether the agent created the right intermediate paperwork.

## Honest handoff

Report:

1. what changed;
2. what behavior was checked;
3. the result;
4. relevant checks that were not run or were blocked;
5. remaining risk that could change the decision.

Plain language is more useful than framework status tiers.
