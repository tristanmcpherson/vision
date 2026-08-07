# Weakest-sufficient hypothesis selection

## What the paper establishes

Michael Timothy Bennett's [The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest, v4](https://arxiv.org/abs/2301.12987) formalizes induction over a finite implementable language. A statement's weakness is the cardinality of its extension: how many decisions are consistent with it. Given the paper's task construction and a uniform distribution over parent tasks, selecting a valid hypothesis with the largest extension is necessary and sufficient to maximize the probability of generalization.

That is different from minimum description length. A short statement can make a very specific claim, while a longer representation can leave many possibilities open. The paper gives a counterexample showing that shortest and weakest need not select the same model. In toy 8-bit addition and multiplication experiments, weakest-model selection achieved higher exact generalization rates and higher average generalization extent than minimum-description-length selection. The experiment is evidence for the formalism in that domain, not a software-engineering benchmark.

## What Vision should take from it

Vision cannot usually enumerate the language, extensions, or distribution of future repository tasks. We therefore should not claim to calculate Bennett's weakness or inherit the paper's optimality theorem.

We can use an auditable approximation during intake:

- A working hypothesis is the outcome interpretation plus its solution-shape, scope, and behavioral commitments.
- A hypothesis is valid only if it fits observed repository facts, explicit user constraints, the requested outcome, authority boundaries, and proportionate verification.
- Between two valid hypotheses that satisfy the same outcome, prefer A when A's unsupported commitment set is a strict subset of B's.
- Representation length is not a tiebreaker. Fewer words, fewer files, or less code do not by themselves imply a weaker hypothesis.
- When commitment sets are incomparable and the difference is material, use Vision's two-finalist decision boundary.

Example: a request to fix duplicate job execution may be satisfied by making the existing handler idempotent. Replacing the queue, promising exactly-once delivery across every future transport, and introducing a generic workflow engine adds commitments not required by the evidence. The local idempotency hypothesis is weaker if both candidates satisfy the same acceptance and risk gates.

## Hard boundary

"Weakest sufficient" applies only after validity is established. It must not be used to:

- remove explicit requirements or recast them as non-goals;
- ignore security, migration, persistence, concurrency, deployment, or other direct risks;
- weaken a failing assertion or substitute irrelevant evidence;
- bypass an approval, credential, or external authority;
- call an ambiguous hypothesis valid when a material owner decision remains unresolved.

The user outcome and observable behavior define sufficiency. Weakness chooses among candidates that satisfy them; weakness never edits the definition of success.

## Evaluation plan

Treat this as a causal component, not a rhetorical improvement. Add a controlled VisionBench ablation with the same task corpus, repository preparation, model family, effort, budgets, and verifier:

- control: current evidence-backed intake without an explicit hypothesis-selection rule;
- treatment: weakest-sufficient selection using commitment-set inclusion and the incomparable-candidate decision rule.

Score existing acceptance and verification outcomes first. Add blinded semantic labels for unsupported commitments, unnecessary dependencies or abstractions, invented compatibility promises, premature user questions, and criteria or gate weakening. Report task-level paired results, cost and latency, inconclusive runs, and any heterogeneous effect by task class. Preserve frozen campaign evidence and start a new campaign for this treatment.

Promotion requires non-inferior verified task success, zero increase in acceptance or gate weakening, and a measured reduction in unsupported commitments on the held-out corpus. Until that result exists, describe the rule as paper-motivated and locally enforced, not empirically validated for software delivery.
