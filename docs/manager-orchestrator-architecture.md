# Manager Orchestrator Architecture

## Architecture summary

Workspace Agent Hub Manager is moving from a single serial inbox worker toward a
real manager/orchestrator model.

The target behavior is:

1. the human sends one freeform instruction
2. the Manager AI decomposes it into concrete work items
3. each work item gets an assignee
4. the Manager answers only the work items it should handle itself
5. the rest are dispatched to worker agents/sub-agents
6. the human sees the work item graph, assignee, live progress, and resulting
   state in one place

The inbox should stay human-first. The human should not need to create folders,
topics, or sub-agents manually.

## Project contract

```yaml
system: workspace-agent-hub-manager
actors:
  - human requester
  - manager orchestrator
  - worker agent or sub-agent
  - runtime scheduler/lock manager
canonical_store:
  work_items:
    file: .threads.jsonl
    model: work-item graph with zero or more parent links
  runtime_state:
    files:
      - .workspace-agent-hub-manager.json
      - .workspace-agent-hub-manager-queue.jsonl
      - .workspace-agent-hub-manager-thread-meta.json
human_surface:
  - Hub native /manager/ page
  - one global send dock
  - one work-item conversation screen
ai_surface:
  - manager routing/orchestration turn
  - worker execution turns
  - future sub-agent dispatch layer
sync:
  direction: canonical store -> live browser snapshot stream
  trigger:
    - manager runtime writes
    - thread/task/meta file changes
    - explicit manager update notifications
validation:
  - repo verify suite
  - browser DOM tests
  - real browser manager flows
outputs:
  - routed work items
  - assignee metadata
  - live worker output
  - review/reply-needed/user-done states
gui_selection:
  pattern: custom GUI
  reason: the canonical routing/orchestration state is Hub-specific and must be
    shared by PC and smartphone on the same authenticated origin
launch:
  human_startup:
    - open Workspace Agent Hub
    - open Manager
    - send once from the global dock
acceptance:
  - one freeform send can produce multiple work items
  - each work item exposes state, assignee, and latest output
  - the browser does not rely on periodic polling for Manager updates
  - the newest worker output is visible at the bottom of the work-item screen
```

## Responsibility split

### System responsibilities

- Persist the canonical work-item graph
- Persist runtime queue/session/assignee state
- Push live snapshots to connected browsers
- Enforce dispatch rules such as queue order, non-overlap constraints, retries,
  cancellation, and supersede application
- Start, stop, and monitor worker agents

### Manager responsibilities

- Interpret one user send into one or more work items
- Decide whether each work item is:
  - a direct manager answer
  - a worker task
  - a routing confirmation
  - a derived follow-up
- Assign priority
- Choose assignee
- Decide whether a new descendant work item supersedes an already-running
  descendant
- Review worker output and move the work item into the correct human-facing
  state

### Worker responsibilities

- Execute exactly one assigned work item
- Report progress and final result
- Return blocker/needs-user-input when necessary

## Canonical data model

The primary visible object is the `work item`.

Each work item may contain:

- `id`
- `title`
- `messages`
- `uiState`
- `derived_from[]`
- `assigneeKind`
- `assigneeLabel`
- `workerSessionId`
- `workerLiveOutput`
- `workerLiveAt`

The work-item graph is closer to a DAG than a folder/topic tree. A new work
item may derive from zero, one, or multiple earlier work items.

## Assignee model

Each work item has exactly one active assignee at a time:

- `manager`
- `worker`
- `sub-agent`

The UI should show both the work item and its current assignee so the human can
see who is responsible now.

## Priority model

The current priority policy is:

1. routing confirmation needed
2. user reply needed
3. AI finished, awaiting user confirmation
4. queued questions
5. queued requests
6. AI working
7. done

Within queued work, questions should outrank ordinary requests. Ties remain
FIFO unless a higher-level explicit priority rule applies.

## Parallel dispatch rule

Parallelism is allowed when the work scopes do not overlap.

Repository boundaries are not enough. The decision should be based on the
effective write/read scope of the work items. If scopes overlap, the runtime
must serialize or block the later dispatch until the conflict is resolved.

## Supersede / cancellation rule

The Manager should not cancel older work by default.

Cancellation is allowed only when:

1. the new work item is a descendant of the same lineage, and
2. its outcome would completely replace or invalidate the still-running
   descendant's output

When this happens, the older assignee should move into a reasoned cancelled
state such as `cancelled-as-superseded`.

## Live update transport

Manager browser updates should not rely on periodic client polling.

The target transport is:

- one long-lived Manager live stream per browser
- server-built snapshots in NDJSON form
- server-side update notifications triggered by canonical-store/runtime writes
- browser-side state replacement from pushed snapshots

Heartbeat frames are allowed only to keep the transport alive; they must not be
used as application-level polling.

## Current implementation status

Already implemented in this line:

- work-item graph terminology and relationships
- Manager live snapshot stream for `/manager/`
- browser-side removal of interval polling on the Manager screen
- live worker output persisted in thread meta and rendered as the latest AI
  bubble at the bottom of the open work-item conversation

Not yet complete:

- real sub-agent orchestration and assignment lifecycle
- non-overlap scope locks for parallel work
- supersede/cancel decisions carried out by the Manager
- explicit manager-vs-worker assignment policy enforcement

## Rollout sequence

1. Keep the work-item graph and live-stream browser model stable
2. Add explicit assignee/worker lifecycle controls
3. Introduce sub-agent dispatch with scope-aware parallelism
4. Add supersede/cancel decisions for descendant conflicts
5. Expose richer assignee state and worker logs in the Manager UI
