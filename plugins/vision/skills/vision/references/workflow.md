# Lightweight workflow

## Intake

Treat the prompt as an outcome, not a malformed specification. Inspect repository behavior, tests, conventions, and nearby documentation. Infer ordinary implementation details yourself.

Ask only when the answer changes product meaning, authority, cost, destructive impact, or an external side effect and cannot be resolved safely from existing context.

## Weakest sufficient hypothesis

Among plausible implementations that satisfy the same outcome, prefer the one with the fewest unsupported commitments.

For example, fixing an idempotency bug in the existing job handler is weaker than replacing the queue and promising exactly-once behavior across future transports. The latter may be justified, but the request and evidence must actually require it.

Compare commitments, not word count, file count, or code length. If two approaches have genuinely different material tradeoffs, explain them and either choose the reversible in-scope option or ask the user when the choice belongs to them.

This adapts Bennett's weakness idea without pretending software repositories satisfy the paper's uniform-task assumption or allow exact extension counting. It is a practical bias against invented specificity, not a theorem about our tasks.

## Build

Find the real seam and make one coherent change. Reuse existing architecture and tools when they are good enough. Avoid new abstractions, dependencies, frameworks, and compatibility promises unless they solve a demonstrated need.

Preserve unrelated dirty work. If the repository is already changing around the target, integrate with it rather than resetting or replacing it wholesale.

## Verify

Choose checks by the claim being made:

| Claim | Useful check |
| --- | --- |
| Local logic works | Focused unit or property test |
| Components integrate | Existing integration test or a direct runtime exercise |
| UI behavior works | Use the UI flow; inspect final state when visual behavior matters |
| API or persistence boundary works | Exercise the real serializer, handler, datastore, or migration path |
| Build/package remains valid | Relevant build, typecheck, lint, or package smoke |
| Deployed behavior works | Existing deployment/observability checks with required approval |

Run the narrow check first. Run a broader repository gate when it is cheap, conventional, or justified by regression risk. Do not run expensive unrelated suites merely to satisfy Vision.

Normal local evidence does not need a Vision schema, nonce, checksum, receipt, or signature. Preserve external platform security controls where the external system actually depends on them.

## Finish

Report the concrete outcome and evidence in plain language. Distinguish a passing focused check from a full regression run, and source inspection from runtime behavior. If something relevant was not checked, name it without converting that gap into a framework status machine.
