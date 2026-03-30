# Manager Multi-Agent Workflow

## Goal

This document defines the day-to-day operator flow for the next Manager phase:

- every write-capable worker runs in its own isolated git worktree
- the human launches work from one Hub surface instead of touching git directly
- merges are handled by repo-scoped AI merge lanes instead of by the human
- multiple worker runtimes (`codex`, `claude`, `gemini`, `copilot`) can share
  the same workflow contract

This is a usage and surface design document. It explains what the human should
see and what the system should automate before expanding the implementation.

## Current line vs next phase

Already implemented in the current line:

- the Manager inbox and work-item graph
- isolated git worktree delivery for Manager worker tasks
- Manager-owned merge, push, and post-merge delivery for worker results
- scope-aware worker parallelism and scope-blocked visibility

Not yet generalized enough for the target operator experience:

- explicit multi-agent worker selection from the human-facing task creation flow
- explicit repo-scoped merge-lane visibility in the UI
- a generic worker-adapter contract shared by `codex`, `claude`, `gemini`, and
  `copilot`
- a clear human-facing "new task" flow that teaches worktree isolation without
  exposing git mechanics

## Product position

Workspace Agent Hub should become the canonical launcher for multi-agent
repository work in this workspace.

The human should not need to:

- choose or create a git worktree manually
- decide whether a task will conflict before launching it
- remember which branch a worker is using
- perform ordinary repo merges when the result is mechanically resolvable

The system should instead:

- create one branch + one worktree per write run
- route each run to the requested worker runtime
- keep completed runs in a repo-scoped merge queue
- let a repo-scoped merge agent integrate them one by one
- escalate only true hard conflicts or ambiguous product decisions

## Project contract

```yaml
system: workspace-agent-hub-manager-next
actors:
  - human requester
  - manager orchestrator
  - worker adapter
  - merge-lane agent
  - conflict-resolution agent
canonical_store:
  runtime_db:
    type: sqlite
    purpose:
      - run metadata
      - worktree metadata
      - merge queues
      - lock state
  thread_store:
    files:
      - .threads.jsonl
      - .tasks.jsonl
human_surface:
  - hub manager inbox
  - new task sheet
  - runs view
  - merge lanes view
  - needs-human queue
ai_surface:
  - manager routing turn
  - worker runtime adapter
  - merge-lane integration turn
  - conflict-resolution turn
sync:
  task_start:
    - inspect discovered workspace repos when targeting an existing repo
    - create task branch + isolated worktree for existing-repo write runs
    - launch worker runtime
  task_finish:
    - verify
    - enqueue in repo merge lane for existing repos
  integration:
    - rebase or merge onto latest base branch
    - verify again
    - push
    - optional release/publish chain
conflict_policy:
  - never silently overwrite another run
  - detect conflicts at integration time
  - let AI resolve mechanical conflicts first
  - escalate only when product intent is ambiguous or automated resolution fails
validation:
  - run-level verification before merge queue entry
  - merge-lane verification before push
  - explicit needs-human state on irreducible blockers
outputs:
  - isolated worktree
  - run log
  - merge-lane record
  - pushed branch or merged mainline commit
gui_selection:
  pattern: hybrid-gui
launch:
  human_startup:
    - open Hub
    - open Manager
    - create task from one launcher surface
```

## Human day-to-day flow

### 1. Start a new write task

The normal human flow should be:

1. Open Hub
2. Open Manager
3. Open the bottom composer
4. Write the request in ordinary language
5. Send it
6. Watch Manager turn it into the right work item in the inbox

The human should never see `git worktree add` or branch plumbing in the normal
flow. Repo targeting should be internal: Manager decides whether the task
belongs on a concrete existing workspace repo or on a brand-new repo under the
workspace root, and only asks for clarification when that decision is genuinely
ambiguous.

### 2. Start a read-only task

Read-only tasks follow the same composer-first launch surface and the same
Manager-owned repo decision path.

If the user explicitly asks for investigation, explanation, or analysis without
changes, Manager should keep the task read-only internally instead of requiring
the human to choose a separate mode in the GUI.

### 3. Observe a running task

The run detail should answer these questions immediately:

- which repo is this operating on
- which worker runtime owns it now
- whether it is read-only or write-capable
- whether it already has an isolated worktree
- whether it is blocked by another run's write scope
- what the worker is doing right now

The human should not need to open raw terminal transcripts to learn basic run
state.

### 4. Hand off to the merge lane

When an existing-repo write run finishes and passes its run-level verification:

1. the run moves to `awaiting-merge`
2. the repo's merge lane picks it up in FIFO order within that lane, subject to
   explicit priority rules
3. the merge-lane agent rebases or merges it onto the latest base branch
4. the merge-lane agent runs repo verification
5. if successful, the merge-lane agent pushes the result

The human should see one queue per existing repo, not one global merge pile.

### 5. Handle conflicts

When integration hits a conflict:

1. the run moves to `conflict-resolving`
2. a conflict-resolution agent tries to fix the merge mechanically
3. verification reruns
4. if still failing, the run moves to `needs-human`

The human should only be interrupted for:

- product-intent ambiguity
- repeated verification failure after AI repair
- destructive action requiring explicit approval

## Primary screens

### Primary send composer

Fields:

- `Instruction`

Inline teaching copy should be minimal. The screen should make these points
obvious structurally:

- Manager will decide whether this is a follow-up, a new work item, or a
  clarification case
- Manager will decide `existing repo` vs `new repo`
- existing-repo write tasks run in isolated worktrees automatically
- merge is handled later by the repo merge lane only for existing repos
- the human can keep sending from one place without touching git or creating a
  task manually

### Runs view

Each run card or row should show:

- title
- repo
- runtime
- mode
- current state
- assignee
- base branch
- created at / updated at
- worktree badge
- blocked-by scope summary when applicable

Suggested states:

- `queued`
- `provisioning`
- `running`
- `verifying`
- `awaiting-merge`
- `merging`
- `conflict-resolving`
- `merged`
- `needs-human`
- `failed`
- `cancelled-as-superseded`

### Merge lanes view

One lane per repo.

Each lane should show:

- repo name
- lane state
  - `idle`
  - `merging`
  - `blocked`
- current run
- queue depth
- latest merge result
- base branch

The point of this view is to replace hidden backend merge behavior with a
visible operational model.

### Needs-human view

This is the only place where human intervention should concentrate.

Typical entries:

- `hard merge conflict`
- `verification still failing after repair`
- `worker request is ambiguous`
- `release/publish requires a human decision`

The human should not have to scan ordinary completed runs to find real blockers.

## Worker adapter contract

All worker runtimes should implement the same adapter contract even when their
underlying launch mechanism differs.

Required adapter capabilities:

- start a run in a specific working directory
- resume the run when supported
- stream live output
- stop or cancel the run
- report terminal status
- preserve enough session identity for follow-up turns

Target worker runtimes:

- `codex`
- `claude`
- `gemini`
- `copilot`

Current implementation note:

- the built-in Manager backend still keeps Manager routing/review turns on
  Codex
- worker turns now go through a shared runtime adapter that can launch
  `codex`, `claude`, `gemini`, or `copilot` without changing the human
  workflow

## CLI surface

The browser UI should be the primary human entrypoint, but the CLI should
mirror the same concepts for automation and debugging.

### Run management

```text
workspace-agent-hub runs create
workspace-agent-hub runs list
workspace-agent-hub runs show <run-id>
workspace-agent-hub runs retry <run-id>
workspace-agent-hub runs cancel <run-id>
```

### Merge lanes

```text
workspace-agent-hub lanes list
workspace-agent-hub lanes show <repo>
workspace-agent-hub lanes retry <repo> <run-id>
```

The CLI must describe the same model as the UI:

- runs
- repos
- lanes
- needs-human items

not raw internal implementation details.

## Current API surface

The shipped Manager UI currently routes new work through the existing inbox
surface and live snapshot stream.

Current resources:

- `GET /api/live`
- `POST /api/manager/global-send`
- `GET /api/threads`
- `PUT /api/threads/:id/resolve`
- `PUT /api/threads/:id/reopen`

Live updates should continue to use the current push model rather than browser
polling.

## Conflict model

The system must distinguish these cases:

1. same repo, clearly overlapping write scope
2. same repo, unknown overlap
3. same repo, no effective overlap
4. different repos

Dispatch policy:

- case 1: allow parallel authoring but serialize integration in the repo lane
- case 2: allow parallel authoring, mark higher merge-risk in the UI
- case 3: allow normal parallel flow
- case 4: allow full parallel flow

The key product rule is:

- do not require the human to predict file overlap before launching work

## Human startup path

The simplest day-1 explanation should be:

1. Open Hub
2. Open Manager
3. Write the request in the normal composer
4. Let Manager choose whether it is a follow-up, a new work item, or a
   clarification path
5. Let Manager choose the repo path internally
6. Let the repo lane merge it later

That is the level of complexity the human should need to remember.

## Acceptance criteria

- a human can launch a write task without touching git directly
- every write run records an isolated branch + worktree before worker start
- completed write runs become visible in a repo-specific merge lane
- merge lanes integrate one run at a time per repo
- hard conflicts surface in `needs-human` instead of failing silently
- the UI makes current owner, current repo, and current lane state obvious
- adding a new worker runtime does not require changing the human task-creation
  flow

## Implementation sequence

1. Expose explicit run and lane state in the Manager UI
2. Introduce the generic worker-adapter interface
3. Keep task creation on the normal composer and keep repo choice manager-owned
4. Keep repo choice manager-owned and clarify that in the UI
5. Add merge-lane and needs-human screens
6. Add runtime availability checks and richer per-runtime operator controls
