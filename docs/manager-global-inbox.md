# Manager Global Inbox Design

## Conclusion

Workspace Agent Hub should evolve the Manager UI from a thread-first tool into a
global inbox with AI-managed topic routing.

The human should not manually choose or create topics when sending. The primary
send path becomes one global composer, and the Manager AI decides whether each
part of the message belongs to an existing topic, a new topic, or an ambiguity
that requires confirmation.

## Problem being solved

The user's real goal is not "manage threads". The real goal is:

1. send thoughts, questions, requests, and follow-ups quickly
2. let AI keep the discussion organized across many concurrent topics
3. avoid losing track of what was asked, what was answered, and what still
   needs user attention

Thread-first sending fails this goal because it forces the human to decide the
topic before sending and makes fragmented work harder to capture quickly.

## Project contract

### Actors

- Human requester
- Workspace Agent Hub Manager UI
- Built-in Manager backend
- Thread storage backend (`thread-inbox` data files)

### Canonical store

- Canonical conversation/topic store: workspace thread data handled by Hub
- Canonical task/status source for Manager follow-up visibility: thread/task
  files already owned by Hub/backend

### Human surface

- `workspace-agent-hub` Manager page
- One global send entrypoint for all new outgoing user input
- Topic list ordered by urgency, not by creation order

### AI surface

- Built-in Manager backend
- Topic routing, ambiguity handling, status suggestion, and actual task execution

### Sync direction and trigger

- Human submits one freeform message
- Manager backend splits it into one or more topic actions
- Actionable topic items are executed by the built-in worker layer, not left as
  acknowledgement-only replies
- Topic list and per-topic detail update from the canonical store
- Polling/reload keeps PC and smartphone aligned to the same state

### Conflict policy

- If routing is confident, AI applies it automatically
- If routing is partially ambiguous, AI routes confident parts immediately and
  creates a highest-priority confirmation item for the ambiguous part only
- If the user later corrects routing in natural language, the AI updates topic
  linkage and status instead of requiring manual drag/drop or retagging

### Validation surfaces

- Global composer result summary near the composer, not detached elsewhere
- Topic list with explicit urgency buckets
- Per-topic detail for deep reading and follow-up
- Rich message detail rendering for multiline text, inline images, and readable
  AI formatting

### Generated artifacts

- AI-generated topic titles
- AI-generated routing summaries
- AI-managed topic state transitions

### Human startup flow

1. Open Hub
2. Open Manager
3. Type into the global composer without choosing a topic
4. Review only the items that need human action first

## Target interaction model

### Global send model

- The human always sends from one global composer
- The composer must not appear to belong to a specific topic
- The composer should stay easy to reach on phone and desktop
- When a routed topic can be matched back to an exact excerpt from the user's
  freeform message, the stored user-side topic message should keep that
  original wording instead of being immediately rewritten into AI-normalized
  prose
- For brand-new topics, the stored user-side message should still be readable
  on its own inside that topic: keep the user's wording as much as possible,
  but add the smallest missing context when the raw excerpt would otherwise be
  too referential to understand alone
- Preferred shape:
  - collapsed low-height docked composer when idle
  - expands into a larger writing surface on interaction
  - rendered preview before send so image placement and markdown structure are
    obvious before queueing

### Topic routing model

Given a freeform message such as:

`AAして、BBして。あと、さっきのCCの件ってどうなってる？`

the Manager should:

1. split the message into candidate intents
2. attach each intent to an existing topic or create a new topic
3. ask for confirmation only for the ambiguous intent(s)
4. write replies back into the resulting topic(s), not only as one top-level
   combined answer

### Natural-language correction model

The user should be able to say things like:

- `それはAの続きです`
- `それは別トピックにして`
- `その件はもうOKです`

The AI should interpret those messages and update topic linkage/state without
requiring explicit manual topic-management UI first.

## Topic state model

The old binary idea of "done/not done" is insufficient. The Manager must
separate AI completion from user closure.

### Required states

1. `routing-confirmation-needed`
   - AI could not confidently place some part of the message
   - Highest priority in the list
2. `user-reply-needed`
   - AI explicitly needs user input before it can continue
   - Next-highest priority
3. `ai-finished-awaiting-user-confirmation`
   - AI believes it completed the work or answered the question
   - User still needs to review the result
4. `queued`
   - Accepted but not started by AI yet
5. `ai-working`
   - AI is actively processing
6. `done`
   - Explicitly closed by the user, or closed from a clear natural-language
     approval such as `その件OK`

### Priority order in the inbox

1. `routing-confirmation-needed`
2. `user-reply-needed`
3. `ai-finished-awaiting-user-confirmation`
4. `queued`
5. `ai-working`
6. `done` (hidden by default, shown only on demand)

`ai-finished-awaiting-user-confirmation` is only for cases where AI has already
produced something the human can now inspect. Intake acknowledgements or
"started working" updates belong in `ai-working` until a real result is ready.

Within `queued`, the default is FIFO by arrival time, but two user intents can
legitimately jump ahead:

- explicit priority requests such as `優先して` or `先に答えて`
- question-only items that should be answered before ordinary backlog

If multiple queued items are in the same priority lane, they stay FIFO. The
queue must also include a fairness cap so older ordinary work is periodically
drained instead of being starved forever by a stream of priority/question
follow-ups.

### Closure rules

- AI must not silently mark a topic as fully done just because it thinks the
  task is complete
- Only the user can finally close a topic
- AI may move a topic into `ai-finished-awaiting-user-confirmation`
- The user may close a topic via:
  - an explicit UI action
  - a natural-language approval that the Manager can interpret confidently

## UI design direction

### What the screen must teach

The Manager screen must make these points obvious without external explanation:

1. `ここではまとめて送ってよい`
2. `task の整理はAIがやる`
3. `今すぐ自分が返すべきものはどれか`
4. `AIが終えたので確認すべきものはどれか`
5. `ここで動く built-in Manager は、task 整理のあとに実際の作業まで進める`

### Primary layout direction

- A single urgency-ordered inbox view
- One global composer anchored consistently across the screen
- A small `what to read first` lane near the top that surfaces the highest
  urgency tasks the human can act on now without making the user scan every
  section
- Opening a task switches into that task's own conversation screen instead of
  expanding detail inline inside the inbox
- Task detail remains available, but the primary mental model is the inbox, not
  thread administration
- Avoid exposing internal thread IDs or infrastructure wording; if stored AI
  text contains an internal ID anyway, render it back to the human as the
  corresponding topic title instead of showing the raw ID
- Make the current composer target obvious: either whole-inbox routing or a
  specific selected task mention hint, without turning that hint into a forced
  destination
- Preserve real conversation shape inside a topic: multiline user messages,
  inline image evidence inserted by drag-and-drop or clipboard paste at the
  current cursor position, and Markdown-formatted AI replies with the newest
  message at the bottom of the conversation

### Routing feedback placement

Routing feedback should appear near the global composer, because that is where
the user's attention is immediately after sending. The just-sent draft should
move into a separate sending/recent lane right away so the composer itself can
reset immediately for the next draft instead of mixing in-flight content with
new edits.

It should be compact, for example:

- `3件に分けました`
- `1件は要確認です`

This feedback is not the main record; the main record remains the topic list.

## Non-goals

- Do not require the human to create topics manually before sending
- Do not make "thread management" the primary mental model
- Do not auto-close topics without user confirmation
- Do not require desktop-only affordances for routine use

## Acceptance criteria for implementation

1. The Manager page has one global send path that does not require selecting a
   topic first.
2. A multi-intent user message can be split into multiple topic updates.
3. A newly created topic stores a user-side message that still makes sense when
   read without the original multi-intent source message.
4. Confidently routed parts proceed immediately even if another part requires
   clarification.
5. Ambiguous routing creates a highest-priority confirmation item instead of
   blocking all work.
6. Topic replies appear in the resulting topic(s), not only as one global
   summary.
7. The inbox clearly distinguishes:
   - routing confirmation needed
   - user reply needed
   - AI finished, user confirmation needed
   - AI execution waiting
   - AI working
   - done
8. `done` items are hidden by default and can be shown on demand.
9. The user can close a topic explicitly and can also close it through a clear
   natural-language approval.
10. The primary mobile and desktop flows avoid horizontal scrolling.
11. The user can understand the next action from the screen itself without
    needing chat guidance.
12. When the user is reading one topic and that topic changes state, the screen
    keeps that topic open in the conversation view so it does not feel lost.
13. When the user is about to send a follow-up to one topic, the target topic
    is visually explicit before send.

## Implementation sequence

1. Rework the Manager state model and list ordering around the new urgency
   buckets.
2. Introduce the global composer and remove manual create-thread dependence from
   the primary path.
3. Add server-side intent splitting and topic-routing orchestration.
4. Add ambiguity handling and a `routing-confirmation-needed` item type/state.
5. Add natural-language topic correction and explicit close semantics.
6. Add browser-level verification for:
   - desktop global send
   - mobile global send
   - split into multiple topics
   - partial ambiguity
   - user-confirmation-needed ordering
   - done hidden-by-default behavior
