# Vision architecture

Vision is an outcome-driven engineering workflow built around explicit contracts, bounded execution, risk-selected verification, and honest completion states. Its execution graph is optional: small or effectively linear work stays linear.

This document separates three different things:

- **Current runtime architecture** — behavior implemented on public `main`.
- **Experimental intake work** — repository-readiness behavior under evaluation, not a current release contract.
- **Evaluation architecture** — how Vision is compared with bare Codex; it does not itself prove effectiveness.

## 1. End-to-end workflow

**Status:** current runtime architecture.

```mermaid
flowchart TD
    U["User outcome seed"] --> R["Repository research"]
    R --> I["Intake synthesis"]
    I --> C["Freeze task contract"]
    C --> G["Create or reconcile canonical goal"]
    G --> L["Activate lifecycle state"]

    L --> E{"Execution shape"}
    E -->|"Linear"| X["Execute one bounded slice"]
    E -->|"Graph"| W["Execute one ready wave"]

    X --> V["Risk-selected verification"]
    W --> V
    V -->|"Failure"| D["Diagnose and bounded repair"]
    D --> L
    V -->|"Pass; more work remains"| L
    V -->|"Acceptance target reached"| H["Report honest completion level"]
```

Vision repeatedly chooses the smallest useful next action until the frozen acceptance contract is satisfied or a real stop condition is reached.

## 2. Repository readiness intake

**Status:** experimental intake behavior, not part of the current public release contract.

```mermaid
flowchart TD
    N["New outcome"] --> P["Inspect repository guidance and verification entrypoints"]
    P --> R{"Repository ready?"}

    R -->|"Ready"| C["Continue into task intake"]
    R -->|"Needs setup"| U{"User permits persistent setup?"}
    R -->|"Blocked"| B["Report blocker; do not claim readiness"]

    U -->|"Prepare repository"| S["Add minimal durable guidance and verification entrypoint"]
    U -->|"Task only"| T["Proceed without setup and report concrete readiness gaps"]

    S --> V["Verify preparation"]
    V --> C
    T --> C
```

This doctor policy is deliberately shown as experimental. It must not be interpreted as shipped behavior until its implementation and matched evaluation land independently.

## 3. Task sizing and execution shape

**Status:** current runtime architecture.

```mermaid
flowchart TD
    T["Evidence-backed task understanding"] --> S{"Small and bounded?"}

    S -->|"Yes"| F["S task: one bounded execution loop"]
    S -->|"No"| Z["M or L task: durable contract and plan"]

    Z --> D{"Independent jobs materially improve execution?"}
    D -->|"No"| L["Linear sequence of slices"]
    D -->|"Yes"| G["Optional execution graph"]

    G --> Q{"Safe parallelism exists?"}
    Q -->|"Yes"| P["Parallel read-only or isolated worktree nodes"]
    Q -->|"No"| W["Serialized graph waves"]
```

Size controls planning persistence and execution shape. It does not weaken verification, grant permissions, or justify parallelism by itself.

## 4. Slice decomposition

**Status:** current runtime architecture, with a known model-authored boundary.

```mermaid
flowchart TD
    A["Frozen acceptance criteria"] --> S["Coordinator selects one coherent behavior increment"]
    D["Dependencies and ownership"] --> S
    K["Required verification"] --> S
    R["Repository seams and risk"] --> S

    S --> B["Durable plan or Bead stores full slice meaning"]
    B --> C["Lifecycle cache stores current slice ID and summary"]
    C --> I["Implement the slice"]
    I --> V["Run slice-specific checks"]

    V -->|"Pass"| N["Choose the next incomplete slice"]
    V -->|"Fail"| X["Diagnose and repair the same slice"]
    X --> V

    M["No explicit current slice"] -.-> F["Fallback to an incomplete acceptance criterion"]
    F --> I
```

Slices are intended to be independently verifiable behavior increments, not arbitrary file groups or role labels. The coordinator currently authors the decomposition; the runtime enforces the selected action but does not mechanically prove that the complete slice set is minimal, non-overlapping, or globally optimal.

## 5. Lifecycle action selection

**Status:** current runtime architecture.

```mermaid
flowchart TD
    R["Resume lifecycle"] --> B{"Explicit blocker?"}
    B -->|"Yes"| BL["Blocker action"]
    B -->|"No"| T{"Terminal or completed?"}

    T -->|"Yes"| C["Completion action"]
    T -->|"No"| F{"Failed evidence exists?"}

    F -->|"Yes"| D["Diagnosis or repair action"]
    F -->|"No"| P{"Protected closure or delivery due?"}

    P -->|"Yes"| H["Verification or delivery action"]
    P -->|"No"| I{"Current implementation slice exists?"}

    I -->|"Yes"| S["Continue current slice"]
    I -->|"No"| V{"Required check incomplete?"}

    V -->|"Yes"| K["Verification action"]
    V -->|"No"| A["Fallback acceptance-criterion action"]
```

The selected “next slice” is really a generic lifecycle action. It may be implementation, verification, diagnosis, protected closure, delivery, completion, or a blocker.

## 6. Optional dependency-aware execution graph

**Status:** current runtime architecture.

```mermaid
flowchart LR
    A["Wave 1: read-only discovery"] -->|"API contract artifact"| B["Wave 2: backend worktree"]
    A -->|"UI constraint artifact"| C["Wave 2: frontend worktree"]

    B -->|"Backend candidate"| D["Wave 3: serialized integration"]
    C -->|"Frontend candidate"| D

    D -->|"Integrated candidate"| E["Wave 4: advisory review"]
    E -.-> P["Protected verification outside the graph"]
```

Each graph node has an explicit execution contract:

```mermaid
flowchart LR
    J["Bounded job"] --> C["Acceptance criterion IDs"]
    J --> I["Required input artifacts"]
    J --> O["Produced output artifacts"]
    J --> E["Executor and isolation"]
    J --> W["Exact write scope"]
```

Edges represent named artifacts consumed downstream, not mere chronology. Required upstream failure blocks fan-in. Independent read-only or worktree-isolated nodes may run together; shared-workspace writers serialize. The graph is frozen at task-contract level—Vision does not generate a new graph for every slice.

## 7. Agent topology and duplication guard

**Status:** current runtime architecture.

```mermaid
flowchart TD
    C["One coordinator"] --> S["Scout: narrow read-only discovery"]
    C --> W1["Worker: bounded owned implementation"]
    C --> W2["Worker: separate isolated scope"]
    C --> R["Reviewer: advisory read-only review"]

    S -->|"Evidence artifact"| C
    W1 -->|"Patch and verification receipt"| C
    W2 -->|"Patch and verification receipt"| C
    R -->|"Findings"| C

    C -.-> P["Protected verifier"]
    P -->|"Signed closure result"| C
```

The coordinator owns the contract, integration, lifecycle state, and final interpretation. Leaf roles do not create competing management trees. Concurrent workers must not receive overlapping write scope, and builder-side agents cannot become protected verifiers merely by running in another chat.

## 8. Verification and authority boundary

**Status:** current runtime architecture.

```mermaid
flowchart TD
    I["Implemented candidate"] --> L["Local focused and broader checks"]
    L --> Q{"Available required checks pass?"}

    Q -->|"No"| N["Implemented, not verified"]
    Q -->|"Yes"| V["Locally verified"]

    V --> G["Controller issues candidate-bound verification grant"]
    G --> P["Protected verifier checks immutable candidate"]
    P --> R{"Closure checks pass?"}

    R -->|"No"| F["Verified failure; return evidence"]
    R -->|"Yes"| C["Closure verified"]

    C --> A["Required delivery approval"]
    A --> D["Delivery controller"]
    D --> H["Delivered and verified"]
```

Builders can produce developer evidence but cannot promote themselves through protected closure. Local tests prove only their declared scope. Protected closure requires an immutable candidate, a trusted harness, protected profiles, and a grant signed outside candidate execution.

## 9. Failure and bounded repair

**Status:** current runtime architecture.

```mermaid
flowchart LR
    V["Verification check"] --> Q{"Result"}
    Q -->|"Pass"| N["Advance lifecycle"]
    Q -->|"Fail"| E["Capture exact failure evidence"]
    E --> D["Diagnose root cause"]
    D --> R["Return ownership to responsible slice or graph node"]
    R --> F["Bounded repair"]
    F --> V

    D --> L{"Progress or retry limit exceeded?"}
    L -->|"Yes"| B["Stop with blocker or valid failure"]
    L -->|"No"| F
```

The gate stays intact. Vision repairs the implementation rather than weakening required checks or relabeling inconclusive evidence as success.

## 10. Matched evaluation against bare Codex

**Status:** evaluation architecture, not runtime architecture and not an effectiveness claim.

```mermaid
flowchart TD
    M["Frozen matched-task manifest"] --> E["Repeated epochs"]

    E --> B["Bare Codex arm"]
    E --> V["Vision arm"]

    B --> BI["Isolated candidate workspace"]
    V --> VI["Isolated candidate workspace"]

    BI --> G["Same semantic grader and hidden checks"]
    VI --> G

    G --> C{"Outcome classification"}
    C --> CP["Valid pass: clean"]
    C --> RP["Valid pass: retry-only"]
    C --> VF["Valid failure"]
    C --> IF["Infrastructure failure"]

    CP --> A["Paired aggregation"]
    RP --> A
    VF --> A
    IF --> A

    A --> O["Compare success, correctness, retries, rework, duplication, tokens, latency, and cost"]
```

Infrastructure failures remain distinct from task failures, and retry-only passes remain distinct from clean passes. Broad claims require repeated matched pairs with frozen manifests and reproducible graders.

## Honest completion states

Vision reports one of four evidence levels:

```mermaid
flowchart LR
    I["implemented-not-verified"] --> L["locally-verified"]
    L --> C["closure-verified"]
    C --> D["delivered-and-verified"]
```

Each transition requires new evidence or authority. Goal state, lifecycle cache, reviewers, and conversation confidence cannot promote the candidate by themselves.

## Main architectural pressure points

- Slice decomposition remains model-authored rather than mechanically optimized.
- The lifecycle's “next slice” abstraction covers several different action kinds.
- Graph fan-out is optional and must justify its coordination cost.
- Orchestration context, intake, retries, and environment recovery can cost more than implementation on small tasks.
- Token savings, parallelism, or cleaner reporting are not wins unless verified task success and verification correctness stay intact.

## Source map

- [Vision workflow](../plugins/vision/skills/vision/SKILL.md)
- [Lifecycle selector](../plugins/vision/scripts/lifecycle-model.mjs)
- [Graph orchestration](graph-orchestration.md)
- [Verification model](verification-model.md)
- [Protected verifier](protected-verifier.md)
- [Campaign protocol](campaign.md)
