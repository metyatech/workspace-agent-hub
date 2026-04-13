/// <reference lib="dom" />

import { marked } from 'marked';
import {
  extractManagerMessageAttachmentIds,
  parseManagerMessage,
  serializeManagerMessage,
  type ManagerMessageAttachment,
} from './manager-message.js';

declare global {
  interface Window {
    GUI_DIR: string;
    MANAGER_AUTH_REQUIRED?: boolean;
    MANAGER_AUTH_STORAGE_KEY?: string;
    MANAGER_API_BASE?: string;
    __workspaceAgentHubManagerDiagnostics?: () => ManagerClientDiagnostics;
    __workspaceAgentHubManagerApp__?: ManagerApp;
  }
}

interface Msg {
  sender: 'ai' | 'user';
  content: string;
  at?: string;
  live?: boolean;
  provisional?: boolean;
  senderLabel?: string;
  key?: string;
}

type ManagerUiState =
  | 'routing-confirmation-needed'
  | 'user-reply-needed'
  | 'ai-finished-awaiting-user-confirmation'
  | 'queued'
  | 'ai-working'
  | 'cancelled-as-superseded'
  | 'done';

type ManagerListSortOrder = 'newest-first' | 'oldest-first';

type ManagerSortPreferenceKey = ManagerUiState | 'tasks';

type ManagerWorkerRuntimeState =
  | 'manager-answering'
  | 'manager-recovery'
  | 'worker-running'
  | 'blocked-by-scope'
  | 'cancelled-as-superseded';

type ManagerWorkerRuntime = 'codex' | 'claude' | 'gemini' | 'copilot';

interface WorkerLiveEntry {
  at: string;
  text: string;
  kind: 'status' | 'output' | 'error';
}

interface LiveActivityStep {
  at: string | null;
  text: string;
  kind: WorkerLiveEntry['kind'];
}

interface LiveActivitySnapshot {
  actorLabel: string;
  runtimeLabel: string | null;
  runtimeDetail: string | null;
  headline: string | null;
  updatedAt: string | null;
  updatedLabel: string | null;
  steps: LiveActivityStep[];
}

interface ThreadView {
  id: string;
  title: string;
  status: string;
  messages: Msg[];
  updatedAt?: string;
  uiState: ManagerUiState;
  previewText: string;
  lastSender: 'ai' | 'user' | null;
  hiddenByDefault: boolean;
  routingConfirmationNeeded: boolean;
  routingHint: string | null;
  derivedFromThreadIds: string[];
  derivedChildThreadIds: string[];
  managedRepoId: string | null;
  managedRepoLabel: string | null;
  managedRepoRoot: string | null;
  repoTargetKind: 'existing-repo' | 'new-repo' | null;
  newRepoName: string | null;
  newRepoRoot: string | null;
  managedBaseBranch: string | null;
  managedVerifyCommand: string | null;
  requestedWorkerRuntime: ManagerWorkerRuntime | null;
  requestedRunMode: 'read-only' | 'write' | null;
  queueDepth: number;
  isWorking: boolean;
  assigneeKind: 'manager' | 'worker' | null;
  assigneeLabel: string | null;
  workerAgentId: string | null;
  workerRuntimeState: ManagerWorkerRuntimeState | null;
  workerRuntimeDetail: string | null;
  workerWriteScopes: string[];
  workerBlockedByThreadIds: string[];
  supersededByThreadId: string | null;
  workerLiveLog: WorkerLiveEntry[];
  workerLiveOutput: string | null;
  workerLiveAt: string | null;
  seedRecoveryPending: boolean;
  seedRecoveryRepoRoot: string | null;
  seedRecoveryRepoLabel: string | null;
  seedRecoveryChangedFiles: string[];
  queueOrder?: number | null;
  queuePriority?: string | null;
}

type ThreadMutationAction = 'resolve' | 'reopen';

interface PendingThreadMutation {
  action: ThreadMutationAction;
  previousThread: ThreadView;
}

interface Task {
  id: string;
  stage?: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface ManagerHistoryState {
  kind: 'workspace-agent-hub-manager';
  screen: 'inbox' | 'thread';
  threadId?: string;
}

interface ManagerStatusPayload {
  running: boolean;
  configured: boolean;
  builtinBackend: boolean;
  health?: 'ok' | 'error' | 'paused';
  detail?: string;
  pendingCount?: number;
  currentQueueId?: string | null;
  currentThreadId?: string | null;
  currentThreadTitle?: string | null;
  errorMessage?: string | null;
  errorAt?: string | null;
}

interface ManagerLiveSnapshotPayload {
  kind: 'snapshot';
  emittedAt: string;
  threads: ThreadView[];
  tasks: Task[];
  status: ManagerStatusPayload;
}

interface ManagerLifecycleDebugEntry {
  at: string;
  event: string;
  detail: string | null;
}

interface ManagerClientDiagnostics {
  generatedAt: string;
  visibilityState: DocumentVisibilityState;
  authTokenPresent: boolean;
  lifecycleRefreshReady: boolean;
  resumeRefreshPending: boolean;
  resumeRefreshInFlight: boolean;
  liveStreamConnected: boolean;
  liveReconnectScheduled: boolean;
  openThreadId: string | null;
  managerCurrentThreadId: string | null;
  lastAppliedSnapshotAt: string | null;
  lastLifecycleRefreshAt: string | null;
  lastLiveEventAt: string | null;
  lastLiveEventKind: string | null;
  recentEvents: ManagerLifecycleDebugEntry[];
}

type ManagerLiveIndicatorTone = 'neutral' | 'ok' | 'warn' | 'danger';

type ManagerLiveIssueKind =
  | 'offline'
  | 'stale-timeout'
  | 'stream-ended'
  | 'stream-error'
  | 'invalid-live-response';

interface ManagerLiveIssue {
  kind: ManagerLiveIssueKind;
  detail: string | null;
  at: number;
}

interface ManagerLiveIndicatorState {
  tone: ManagerLiveIndicatorTone;
  label: string;
  detail: string;
}

function snapshotEmittedAtValue(emittedAt: string | null | undefined): number {
  if (typeof emittedAt !== 'string' || !emittedAt.trim()) {
    return 0;
  }
  const parsed = Date.parse(emittedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ManagerRoutingSummaryItem {
  threadId: string;
  title: string;
  outcome:
    | 'attached-existing'
    | 'created-new'
    | 'routing-confirmation'
    | 'resolved-existing';
  reason: string;
}

interface ManagerRoutingSummary {
  items: ManagerRoutingSummaryItem[];
  routedCount: number;
  ambiguousCount: number;
  detail: string;
}

interface ThreadComposerSendRequest {
  route: 'thread';
  threadId: string;
  content: string;
}

interface GlobalComposerSendRequest {
  route: 'global';
  contextThreadId: string | null;
  content: string;
}

type ComposerSendRequest =
  | ThreadComposerSendRequest
  | GlobalComposerSendRequest;

type ComposerFeedbackStatus = 'sending' | 'retrying' | 'sent' | 'failed';

interface ComposerFeedbackEntry {
  id: string;
  content: string;
  targetLabel: string;
  status: ComposerFeedbackStatus;
  detail: string;
  items: ManagerRoutingSummaryItem[];
  request: ComposerSendRequest | null;
  attemptCount: number;
  nextRetryAt: string | null;
}

interface StoredComposerFeedbackPayload {
  entries: ComposerFeedbackEntry[];
}

interface StyleEntry {
  bg: string;
  color: string;
  border: string;
}

interface AnsiStyleState {
  foreground: string | null;
  background: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

const ALLOWED_MARKDOWN_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

const ANSI_CSI_PATTERN = /\u001b\[([0-9;?]*)([A-Za-z])/g;
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_16_COLOR_PALETTE = [
  '#0f172a',
  '#ff7b72',
  '#3fb950',
  '#d29922',
  '#79c0ff',
  '#d2a8ff',
  '#56d4dd',
  '#e5e7eb',
  '#6e7681',
  '#ffa198',
  '#56d364',
  '#e3b341',
  '#a5d6ff',
  '#f0b6ff',
  '#7ee7f2',
  '#f8fafc',
];

const GUI_DIR = window.GUI_DIR;
const MANAGER_AUTH_REQUIRED = Boolean(window.MANAGER_AUTH_REQUIRED);
const MANAGER_FEEDBACK_STORAGE_KEY = `workspace-agent-hub.manager-feedback:${GUI_DIR}`;
const MANAGER_SORT_STORAGE_KEY = `workspace-agent-hub.manager-sort:${GUI_DIR}`;
const MANAGER_API_BASE = window.MANAGER_API_BASE || './api';
const MANAGER_HISTORY_KIND = 'workspace-agent-hub-manager';
const COMPOSER_FEEDBACK_MAX_ENTRIES = 4;
const COMPOSER_SEND_RETRY_DELAYS_MS = [0, 2000, 5000, 10000, 30000] as const;
const LIVE_STREAM_STALE_TIMEOUT_MS = 45000;
const MANAGER_DIAGNOSTIC_EVENT_LIMIT = 40;

const STATE_ORDER: ManagerUiState[] = [
  'routing-confirmation-needed',
  'user-reply-needed',
  'ai-finished-awaiting-user-confirmation',
  'queued',
  'ai-working',
  'cancelled-as-superseded',
  'done',
];

const SORTABLE_SECTION_KEYS: ManagerSortPreferenceKey[] = [
  ...STATE_ORDER,
  'tasks',
];

const DEFAULT_MANAGER_SORT_ORDERS: Record<
  ManagerSortPreferenceKey,
  ManagerListSortOrder
> = {
  'routing-confirmation-needed': 'oldest-first',
  'user-reply-needed': 'oldest-first',
  'ai-finished-awaiting-user-confirmation': 'oldest-first',
  queued: 'newest-first',
  'ai-working': 'newest-first',
  'cancelled-as-superseded': 'newest-first',
  done: 'newest-first',
  tasks: 'newest-first',
};

const SORT_CONTROL_LABELS: Record<ManagerSortPreferenceKey, string> = {
  'routing-confirmation-needed': '振り分けの確認が必要です',
  'user-reply-needed': 'あなたの返信が必要です',
  'ai-finished-awaiting-user-confirmation': 'あなたの確認待ちです',
  queued: 'AI の順番待ち',
  'ai-working': 'AI が作業中です',
  'cancelled-as-superseded': '置き換えで停止',
  done: '完了',
  tasks: '残っている作業メモ',
};

const STATE_PRIORITY_RANK = Object.fromEntries(
  STATE_ORDER.map((state, index) => [state, index])
) as Record<ManagerUiState, number>;

const STATE_LABELS: Record<ManagerUiState, string> = {
  'routing-confirmation-needed': '振り分け確認',
  'user-reply-needed': 'あなたの返信待ち',
  'ai-finished-awaiting-user-confirmation': 'あなたの確認待ち',
  queued: 'AI の順番待ち',
  'ai-working': 'AI作業中',
  'cancelled-as-superseded': '置き換えで停止',
  done: '完了',
};

const STATE_STYLES: Record<ManagerUiState, StyleEntry> = {
  'routing-confirmation-needed': {
    bg: 'rgba(127, 29, 29, 0.82)',
    color: '#fecaca',
    border: 'rgba(248, 113, 113, 0.38)',
  },
  'user-reply-needed': {
    bg: 'rgba(120, 53, 15, 0.82)',
    color: '#fde68a',
    border: 'rgba(245, 158, 11, 0.42)',
  },
  'ai-finished-awaiting-user-confirmation': {
    bg: 'rgba(76, 29, 149, 0.82)',
    color: '#ddd6fe',
    border: 'rgba(168, 85, 247, 0.32)',
  },
  queued: {
    bg: 'rgba(8, 47, 73, 0.84)',
    color: '#bae6fd',
    border: 'rgba(56, 189, 248, 0.34)',
  },
  'ai-working': {
    bg: 'rgba(20, 83, 45, 0.84)',
    color: '#bbf7d0',
    border: 'rgba(34, 197, 94, 0.34)',
  },
  'cancelled-as-superseded': {
    bg: 'rgba(68, 64, 60, 0.84)',
    color: '#fde68a',
    border: 'rgba(245, 158, 11, 0.26)',
  },
  done: {
    bg: 'rgba(31, 41, 55, 0.84)',
    color: '#d1d5db',
    border: 'rgba(107, 114, 128, 0.28)',
  },
};

const TASK_STAGE_LABELS: Record<string, string> = {
  pending: 'これから',
  'in-progress': '進行中',
  committed: 'commit 済み',
  released: '公開済み',
  done: '完了',
};

function normalizeManagerSortOrder(
  value: unknown
): ManagerListSortOrder | null {
  if (value === 'newest-first' || value === 'oldest-first') {
    return value;
  }
  return null;
}

function isManagerSortPreferenceKey(
  value: string | null
): value is ManagerSortPreferenceKey {
  return Boolean(value && (SORTABLE_SECTION_KEYS as string[]).includes(value));
}

function readStoredManagerSortOrders(): Partial<
  Record<ManagerSortPreferenceKey, ManagerListSortOrder>
> {
  try {
    const raw = window.localStorage.getItem(MANAGER_SORT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const next: Partial<
      Record<ManagerSortPreferenceKey, ManagerListSortOrder>
    > = {};
    for (const key of SORTABLE_SECTION_KEYS) {
      const sortOrder = normalizeManagerSortOrder(parsed[key]);
      if (sortOrder) {
        next[key] = sortOrder;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function buildManagerSortOrders(): Record<
  ManagerSortPreferenceKey,
  ManagerListSortOrder
> {
  const stored = readStoredManagerSortOrders();
  return Object.fromEntries(
    SORTABLE_SECTION_KEYS.map((key) => [
      key,
      stored[key] ?? DEFAULT_MANAGER_SORT_ORDERS[key],
    ])
  ) as Record<ManagerSortPreferenceKey, ManagerListSortOrder>;
}

function writeStoredManagerSortOrders(
  sortOrders: Record<ManagerSortPreferenceKey, ManagerListSortOrder>
): void {
  try {
    window.localStorage.setItem(
      MANAGER_SORT_STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          SORTABLE_SECTION_KEYS.map((key) => [key, sortOrders[key]])
        )
      )
    );
  } catch {
    /* ignore */
  }
}

function managerSortOrderLabel(order: ManagerListSortOrder): string {
  return order === 'newest-first' ? '新しい順' : '古い順';
}

function managerSortOrderChipLabel(order: ManagerListSortOrder): string {
  return order === 'newest-first' ? '上: 新しい' : '上: 古い';
}

function toggleManagerSortOrder(
  order: ManagerListSortOrder
): ManagerListSortOrder {
  return order === 'newest-first' ? 'oldest-first' : 'newest-first';
}

function threadUpdatedAtUnix(thread: ThreadView): number {
  const candidate = thread.updatedAt || thread.messages.at(-1)?.at || '';
  const unix = candidate ? new Date(candidate).getTime() : Number.NaN;
  return Number.isFinite(unix) ? unix : 0;
}

function taskUpdatedAtUnix(task: Task): number {
  const candidate = task.updatedAt || task.createdAt || '';
  const unix = candidate ? new Date(candidate).getTime() : Number.NaN;
  return Number.isFinite(unix) ? unix : 0;
}

function compareThreadsByUpdatedAt(
  left: ThreadView,
  right: ThreadView,
  sortOrder: ManagerListSortOrder
): number {
  const leftUnix = threadUpdatedAtUnix(left);
  const rightUnix = threadUpdatedAtUnix(right);
  if (leftUnix !== rightUnix) {
    return sortOrder === 'oldest-first'
      ? leftUnix - rightUnix
      : rightUnix - leftUnix;
  }

  if (left.uiState === 'queued' && right.uiState === 'queued') {
    const leftQueueOrder = left.queueOrder ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queueOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
      return sortOrder === 'oldest-first'
        ? leftQueueOrder - rightQueueOrder
        : rightQueueOrder - leftQueueOrder;
    }
  }

  const stateDiff =
    STATE_PRIORITY_RANK[left.uiState] - STATE_PRIORITY_RANK[right.uiState];
  if (stateDiff !== 0) {
    return stateDiff;
  }

  const titleDiff = left.title.localeCompare(right.title, 'ja-JP');
  if (titleDiff !== 0) {
    return titleDiff;
  }

  return left.id.localeCompare(right.id, 'ja-JP');
}

function sortThreadsByUpdatedAt(
  threads: ThreadView[],
  sortOrder: ManagerListSortOrder
): ThreadView[] {
  return [...threads].sort((left, right) =>
    compareThreadsByUpdatedAt(left, right, sortOrder)
  );
}

function sortTasksByUpdatedAt(
  tasks: Task[],
  sortOrder: ManagerListSortOrder
): Task[] {
  return [...tasks].sort((left, right) => {
    const leftUnix = taskUpdatedAtUnix(left);
    const rightUnix = taskUpdatedAtUnix(right);
    if (leftUnix !== rightUnix) {
      return sortOrder === 'oldest-first'
        ? leftUnix - rightUnix
        : rightUnix - leftUnix;
    }

    const leftDescription = left.description || '';
    const rightDescription = right.description || '';
    const descriptionDiff = leftDescription.localeCompare(
      rightDescription,
      'ja-JP'
    );
    if (descriptionDiff !== 0) {
      return descriptionDiff;
    }

    return (left.id || '').localeCompare(right.id || '', 'ja-JP');
  });
}

function readManagerHistoryState(): ManagerHistoryState | null {
  const state = window.history.state as Partial<ManagerHistoryState> | null;
  if (!state || state.kind !== MANAGER_HISTORY_KIND) {
    return null;
  }
  if (state.screen === 'inbox') {
    return { kind: MANAGER_HISTORY_KIND, screen: 'inbox' };
  }
  if (state.screen === 'thread' && typeof state.threadId === 'string') {
    return {
      kind: MANAGER_HISTORY_KIND,
      screen: 'thread',
      threadId: state.threadId,
    };
  }
  return null;
}

function inboxHistoryState(): ManagerHistoryState {
  return {
    kind: MANAGER_HISTORY_KIND,
    screen: 'inbox',
  };
}

function threadHistoryState(threadId: string): ManagerHistoryState {
  return {
    kind: MANAGER_HISTORY_KIND,
    screen: 'thread',
    threadId,
  };
}

function humanizeTaskStage(stage?: string): string {
  const key = stage?.trim();
  return key ? (TASK_STAGE_LABELS[key] ?? key) : '未整理';
}

function humanizeWorkerRuntime(runtime: ManagerWorkerRuntime | null): string {
  switch (runtime) {
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'Copilot';
    case 'codex':
    default:
      return 'Codex';
  }
}

function humanizeRunMode(mode: 'read-only' | 'write' | null): string {
  return mode === 'read-only' ? 'read-only' : 'write';
}

class AuthRequiredError extends Error {
  constructor() {
    super('Access code required');
    this.name = 'AuthRequiredError';
  }
}

function readStoredAuthToken(): string | null {
  try {
    const token = window.localStorage.getItem(managerAuthStorageKey());
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

function writeStoredAuthToken(token: string): void {
  try {
    window.localStorage.setItem(managerAuthStorageKey(), token);
  } catch {
    /* ignore */
  }
}

function clearStoredAuthToken(): void {
  try {
    window.localStorage.removeItem(managerAuthStorageKey());
  } catch {
    /* ignore */
  }
}

function managerAuthStorageKey(): string {
  return (
    window.MANAGER_AUTH_STORAGE_KEY ||
    `workspace-agent-hub.token:${window.GUI_DIR}`
  );
}

function normalizeComposerFeedbackStatus(
  value: unknown
): ComposerFeedbackStatus | null {
  if (
    value === 'sending' ||
    value === 'retrying' ||
    value === 'sent' ||
    value === 'failed'
  ) {
    return value;
  }
  return null;
}

function normalizeComposerSendRequest(
  value: unknown
): ComposerSendRequest | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const request = value as Partial<ComposerSendRequest>;
  if (request.route === 'thread') {
    if (
      typeof request.threadId !== 'string' ||
      typeof request.content !== 'string'
    ) {
      return null;
    }
    return {
      route: 'thread',
      threadId: request.threadId,
      content: request.content,
    };
  }
  if (request.route === 'global') {
    if (
      typeof request.content !== 'string' ||
      (request.contextThreadId !== null &&
        typeof request.contextThreadId !== 'string' &&
        typeof request.contextThreadId !== 'undefined')
    ) {
      return null;
    }
    return {
      route: 'global',
      contextThreadId: request.contextThreadId ?? null,
      content: request.content,
    };
  }
  return null;
}

function normalizeRoutingSummaryItem(
  value: unknown
): ManagerRoutingSummaryItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = value as Partial<ManagerRoutingSummaryItem>;
  if (
    typeof item.threadId !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.reason !== 'string'
  ) {
    return null;
  }
  if (
    item.outcome !== 'attached-existing' &&
    item.outcome !== 'created-new' &&
    item.outcome !== 'routing-confirmation' &&
    item.outcome !== 'resolved-existing'
  ) {
    return null;
  }
  return {
    threadId: item.threadId,
    title: item.title,
    outcome: item.outcome,
    reason: item.reason,
  };
}

function normalizeComposerFeedbackEntry(
  value: unknown
): ComposerFeedbackEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entry = value as Partial<ComposerFeedbackEntry>;
  const status = normalizeComposerFeedbackStatus(entry.status);
  const request = normalizeComposerSendRequest(entry.request);
  if (
    !status ||
    typeof entry.id !== 'string' ||
    typeof entry.content !== 'string' ||
    typeof entry.targetLabel !== 'string' ||
    typeof entry.detail !== 'string'
  ) {
    return null;
  }
  const items = Array.isArray(entry.items)
    ? entry.items
        .map((item) => normalizeRoutingSummaryItem(item))
        .filter((item): item is ManagerRoutingSummaryItem => item !== null)
    : [];
  const attemptCount =
    typeof entry.attemptCount === 'number' &&
    Number.isFinite(entry.attemptCount) &&
    entry.attemptCount >= 0
      ? Math.trunc(entry.attemptCount)
      : 0;
  const nextRetryAt =
    typeof entry.nextRetryAt === 'string' && entry.nextRetryAt.trim()
      ? entry.nextRetryAt
      : null;
  return {
    id: entry.id,
    content: entry.content,
    targetLabel: entry.targetLabel,
    status: status === 'retrying' && !request ? 'failed' : status,
    detail: entry.detail,
    items,
    request,
    attemptCount,
    nextRetryAt,
  };
}

function readStoredComposerFeedbackEntries(): ComposerFeedbackEntry[] {
  try {
    const raw = window.localStorage.getItem(MANAGER_FEEDBACK_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as
      | StoredComposerFeedbackPayload
      | ComposerFeedbackEntry[];
    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.entries)
        ? parsed.entries
        : [];
    return entries
      .map((entry) => normalizeComposerFeedbackEntry(entry))
      .filter((entry): entry is ComposerFeedbackEntry => entry !== null)
      .slice(0, COMPOSER_FEEDBACK_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeStoredComposerFeedbackEntries(
  entries: ComposerFeedbackEntry[]
): void {
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(MANAGER_FEEDBACK_STORAGE_KEY);
      return;
    }
    const payload: StoredComposerFeedbackPayload = {
      entries: entries.slice(0, COMPOSER_FEEDBACK_MAX_ENTRIES),
    };
    window.localStorage.setItem(
      MANAGER_FEEDBACK_STORAGE_KEY,
      JSON.stringify(payload)
    );
  } catch {
    /* ignore */
  }
}

async function apiFetchWithToken(
  token: string | null,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const requestUrl = input.startsWith('/api/')
    ? `${MANAGER_API_BASE}${input.slice('/api'.length)}`
    : input;
  const headers = new Headers(init.headers ?? {});
  if (token) {
    headers.set('X-Workspace-Agent-Hub-Token', token);
  }
  const response = await fetch(requestUrl, { ...init, headers });
  if (response.status === 401) {
    throw new AuthRequiredError();
  }
  return response;
}

function formatAge(iso: string | undefined): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return 'いま';
  if (diffMinutes < 60) return `${diffMinutes}分前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}時間前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}日前`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}週間前`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

const GENERIC_LIVE_PROGRESS_TEXT =
  '進捗イベントを受信しましたが、まだ説明文は届いていません。';

const STRUCTURED_LIVE_DECISION_LABELS: Record<string, string> = {
  'fix-self': '今の修正をそのまま継続',
  'retry-worker': 'worker に修正を再実行',
  restart: '作業をやり直し',
  escalate: '人への確認が必要',
};

function truncateText(value: string, maxLength = 96): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function simplifyLiveText(
  value: string,
  threadTitlesById: Map<string, string>
): string {
  return humanizeThreadReferenceText(value, threadTitlesById)
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseStructuredLivePayload(
  value: string
): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function renderStructuredLivePayload(
  value: string,
  threadTitlesById: Map<string, string>
): string | null {
  const parsed = parseStructuredLivePayload(value);
  if (!parsed) {
    return null;
  }
  const decision =
    typeof parsed['decision'] === 'string' ? parsed['decision'] : null;
  const reason = typeof parsed['reason'] === 'string' ? parsed['reason'] : null;
  if (!decision) {
    return null;
  }
  const decisionLabel =
    STRUCTURED_LIVE_DECISION_LABELS[decision] ??
    simplifyLiveText(decision, threadTitlesById);
  const reasonText = reason ? simplifyLiveText(reason, threadTitlesById) : null;
  return reasonText
    ? `回復判断: ${decisionLabel} / ${truncateText(reasonText, 84)}`
    : `回復判断: ${decisionLabel}`;
}

function assigneeDisplayLabel(thread: ThreadView): string {
  if (thread.assigneeKind === 'manager') {
    return 'Manager';
  }
  if (thread.assigneeKind === 'worker') {
    return 'Worker';
  }
  return 'AI';
}

function renderLiveStep(
  entry: WorkerLiveEntry,
  threadTitlesById: Map<string, string>
): LiveActivityStep | null {
  const rawText = entry.text.trim();
  if (!rawText) {
    return null;
  }
  const structuredText = renderStructuredLivePayload(rawText, threadTitlesById);
  const text = structuredText ?? simplifyLiveText(rawText, threadTitlesById);
  if (!text) {
    return null;
  }
  return {
    at: entry.at ?? null,
    text,
    kind: entry.kind,
  };
}

function collectLiveActivitySteps(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): LiveActivityStep[] {
  const steps: LiveActivityStep[] = [];
  for (const entry of thread.workerLiveLog) {
    const rendered = renderLiveStep(entry, threadTitlesById);
    if (!rendered) {
      continue;
    }
    const previous = steps.at(-1);
    if (previous?.text === rendered.text && previous.kind === rendered.kind) {
      continue;
    }
    steps.push(rendered);
  }
  return steps;
}

function liveRuntimeDetail(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): string | null {
  if (!thread.workerRuntimeDetail?.trim()) {
    return null;
  }
  return simplifyLiveText(thread.workerRuntimeDetail, threadTitlesById);
}

function describeLiveActivity(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): LiveActivitySnapshot | null {
  const runtimeDetail = liveRuntimeDetail(thread, threadTitlesById);
  const steps = collectLiveActivitySteps(thread, threadTitlesById);
  if (!thread.isWorking && !runtimeDetail && steps.length === 0) {
    return null;
  }
  const latestOutput = [...steps]
    .reverse()
    .find((entry) => entry.kind === 'output');
  const latestAny = steps.at(-1) ?? null;
  const fallbackOutput = thread.workerLiveOutput?.trim()
    ? simplifyLiveText(thread.workerLiveOutput, threadTitlesById)
    : null;
  const headline =
    latestOutput?.text ??
    runtimeDetail ??
    latestAny?.text ??
    fallbackOutput ??
    null;
  return {
    actorLabel: assigneeDisplayLabel(thread),
    runtimeLabel: workerRuntimeLabel(thread),
    runtimeDetail,
    headline,
    updatedAt: thread.workerLiveAt ?? null,
    updatedLabel: thread.workerLiveAt
      ? `最終更新 ${formatAge(thread.workerLiveAt)}`
      : null,
    steps,
  };
}

function hashMessageContent(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildThreadTitleMap(threads: ThreadView[]): Map<string, string> {
  return new Map(
    threads
      .filter((thread) => thread.id.trim() && thread.title.trim())
      .map((thread) => [thread.id, thread.title])
  );
}

function buildThreadMap(threads: ThreadView[]): Map<string, ThreadView> {
  return new Map(
    threads
      .filter((thread) => thread.id.trim())
      .map((thread) => [thread.id, thread])
  );
}

function humanizeThreadReferenceText(
  text: string,
  threadTitlesById: Map<string, string>
): string {
  if (!text || threadTitlesById.size === 0) {
    return text;
  }

  let result = text;
  const entries = Array.from(threadTitlesById.entries()).sort(
    (left, right) => right[0].length - left[0].length
  );

  for (const [threadId, title] of entries) {
    const label = `「${title}」`;
    const escapedId = escapeRegExp(threadId);
    result = result.replace(
      new RegExp(`\\[Thread:\\s*${escapedId}\\]`, 'g'),
      `[Work Item: ${label}]`
    );
    result = result.replace(
      new RegExp(`threadId\\s*[:=]\\s*${escapedId}`, 'gi'),
      `work item ${label}`
    );
    result = result.replace(
      new RegExp(`task\\s*ID\\s*[:=]?\\s*${escapedId}`, 'gi'),
      `work item ${label}`
    );
    result = result.replace(
      new RegExp(`(^|[^A-Za-z0-9_-])(${escapedId})(?=$|[^A-Za-z0-9_-])`, 'g'),
      (_match, prefix: string) => `${prefix}${label}`
    );
  }

  return result;
}

function sanitizeLinkHref(href: string | null): string | null {
  if (!href) {
    return null;
  }
  const normalized = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(normalized)) {
    return normalized;
  }
  return null;
}

function resolveImageSrc(
  src: string | null,
  attachments: Map<string, ManagerMessageAttachment>
): string | null {
  if (!src) {
    return null;
  }
  const normalized = src.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(normalized)) {
    return normalized;
  }
  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('attachment://')) {
    const attachmentId = normalized.slice('attachment://'.length);
    return attachments.get(attachmentId)?.dataUrl ?? null;
  }
  return null;
}

function makeDefaultAnsiStyleState(): AnsiStyleState {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

function rgbToHex(red: number, green: number, blue: number): string {
  const clamp = (value: number): string =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
  return `#${clamp(red)}${clamp(green)}${clamp(blue)}`;
}

function xtermColor(index: number): string | null {
  if (index < 0 || index > 255) {
    return null;
  }
  if (index < ANSI_16_COLOR_PALETTE.length) {
    return ANSI_16_COLOR_PALETTE[index] ?? null;
  }
  if (index >= 16 && index <= 231) {
    const cubeIndex = index - 16;
    const red = Math.floor(cubeIndex / 36);
    const green = Math.floor((cubeIndex % 36) / 6);
    const blue = cubeIndex % 6;
    const convertCubeChannel = (value: number): number =>
      value === 0 ? 0 : 55 + value * 40;
    return rgbToHex(
      convertCubeChannel(red),
      convertCubeChannel(green),
      convertCubeChannel(blue)
    );
  }
  const gray = 8 + (index - 232) * 10;
  return rgbToHex(gray, gray, gray);
}

function parseAnsiCodes(parameters: string): number[] {
  if (!parameters) {
    return [0];
  }
  const codes = parameters
    .split(';')
    .map((part) => (part === '' ? 0 : Number(part)))
    .filter((part) => Number.isFinite(part));
  return codes.length > 0 ? codes : [0];
}

function setAnsiColor(
  state: AnsiStyleState,
  type: 'foreground' | 'background',
  color: string | null
): void {
  state[type] = color;
}

function applyAnsiCodes(state: AnsiStyleState, codes: number[]): void {
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    switch (code) {
      case 0:
        Object.assign(state, makeDefaultAnsiStyleState());
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dim = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 7:
        state.inverse = true;
        break;
      case 9:
        state.strike = true;
        break;
      case 21:
      case 22:
        state.bold = false;
        state.dim = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 27:
        state.inverse = false;
        break;
      case 29:
        state.strike = false;
        break;
      case 39:
        state.foreground = null;
        break;
      case 49:
        state.background = null;
        break;
      default:
        if (code >= 30 && code <= 37) {
          setAnsiColor(state, 'foreground', xtermColor(code - 30));
          break;
        }
        if (code >= 40 && code <= 47) {
          setAnsiColor(state, 'background', xtermColor(code - 40));
          break;
        }
        if (code >= 90 && code <= 97) {
          setAnsiColor(state, 'foreground', xtermColor(code - 90 + 8));
          break;
        }
        if (code >= 100 && code <= 107) {
          setAnsiColor(state, 'background', xtermColor(code - 100 + 8));
          break;
        }
        if ((code === 38 || code === 48) && index + 1 < codes.length) {
          const mode = codes[index + 1];
          const target = code === 38 ? 'foreground' : 'background';
          if (mode === 5 && index + 2 < codes.length) {
            setAnsiColor(state, target, xtermColor(codes[index + 2]!));
            index += 2;
            break;
          }
          if (mode === 2 && index + 4 < codes.length) {
            setAnsiColor(
              state,
              target,
              rgbToHex(codes[index + 2]!, codes[index + 3]!, codes[index + 4]!)
            );
            index += 4;
          }
        }
        break;
    }
  }
}

function createAnsiSegment(
  ownerDocument: Document,
  text: string,
  state: AnsiStyleState
): Node | null {
  if (!text) {
    return null;
  }

  const effectiveForeground = state.inverse
    ? (state.background ?? '#f8fafc')
    : state.foreground;
  const effectiveBackground = state.inverse
    ? (state.foreground ?? 'rgba(15, 23, 42, 0.92)')
    : state.background;
  const hasDecoration =
    state.bold ||
    state.dim ||
    state.italic ||
    state.underline ||
    state.strike ||
    effectiveForeground !== null ||
    effectiveBackground !== null;
  if (!hasDecoration) {
    return ownerDocument.createTextNode(text);
  }

  const span = ownerDocument.createElement('span');
  span.className = 'ansi-segment';
  span.textContent = text;
  if (effectiveForeground) {
    span.style.color = effectiveForeground;
  }
  if (effectiveBackground) {
    span.style.backgroundColor = effectiveBackground;
  }
  if (state.bold) {
    span.style.fontWeight = '700';
  }
  if (state.dim) {
    span.style.opacity = '0.72';
  }
  if (state.italic) {
    span.style.fontStyle = 'italic';
  }
  const decorations: string[] = [];
  if (state.underline) {
    decorations.push('underline');
  }
  if (state.strike) {
    decorations.push('line-through');
  }
  if (decorations.length > 0) {
    span.style.textDecoration = decorations.join(' ');
  }
  return span;
}

function renderAnsiTextNode(
  ownerDocument: Document,
  rawText: string
): DocumentFragment | null {
  const text = rawText.replace(ANSI_OSC_PATTERN, '');
  const fragment = ownerDocument.createDocumentFragment();
  const state = makeDefaultAnsiStyleState();
  let cursor = 0;
  let sawAnsi = text !== rawText;
  ANSI_CSI_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(ANSI_CSI_PATTERN)) {
    const start = match.index ?? 0;
    sawAnsi = true;
    const textBefore = text.slice(cursor, start);
    const segment = createAnsiSegment(ownerDocument, textBefore, state);
    if (segment) {
      fragment.appendChild(segment);
    }
    if (match[2] === 'm') {
      applyAnsiCodes(state, parseAnsiCodes(match[1] ?? ''));
    }
    cursor = start + match[0].length;
  }

  if (!sawAnsi) {
    return null;
  }

  const trailing = createAnsiSegment(ownerDocument, text.slice(cursor), state);
  if (trailing) {
    fragment.appendChild(trailing);
  }
  return fragment;
}

function renderAnsiTextNodes(root: ParentNode): void {
  const rootNode = root as Node;
  const ownerDocument =
    rootNode.nodeType === 9 ? (root as Document) : rootNode.ownerDocument;
  if (!ownerDocument) {
    return;
  }
  const nodeFilter = ownerDocument.defaultView?.NodeFilter;
  const walker = ownerDocument.createTreeWalker(
    root,
    nodeFilter?.SHOW_TEXT ?? 4
  );
  const textNodes: Text[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    if ((current.textContent ?? '').includes('\u001b')) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const rendered = renderAnsiTextNode(
      ownerDocument,
      textNode.textContent ?? ''
    );
    if (!rendered) {
      continue;
    }
    textNode.replaceWith(rendered);
  }
}

function sanitizeMarkdownChildren(
  ownerDocument: Document,
  sourceParent: ParentNode,
  attachments: Map<string, ManagerMessageAttachment>
): DocumentFragment {
  const fragment = ownerDocument.createDocumentFragment();
  for (const child of Array.from(sourceParent.childNodes)) {
    const sanitized = sanitizeMarkdownNode(ownerDocument, child, attachments);
    if (sanitized) {
      fragment.appendChild(sanitized);
    }
  }
  return fragment;
}

function sanitizeMarkdownNode(
  ownerDocument: Document,
  node: Node,
  attachments: Map<string, ManagerMessageAttachment>
): Node | null {
  const textNodeType = ownerDocument.defaultView?.Node.TEXT_NODE ?? 3;
  const elementNodeType = ownerDocument.defaultView?.Node.ELEMENT_NODE ?? 1;

  if (node.nodeType === textNodeType) {
    return ownerDocument.createTextNode(node.textContent ?? '');
  }
  if (node.nodeType !== elementNodeType) {
    return null;
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  if (!ALLOWED_MARKDOWN_TAGS.has(tagName)) {
    return sanitizeMarkdownChildren(ownerDocument, element, attachments);
  }

  if (tagName === 'a') {
    const href = sanitizeLinkHref(element.getAttribute('href'));
    if (!href) {
      return sanitizeMarkdownChildren(ownerDocument, element, attachments);
    }
    const clean = ownerDocument.createElement('a');
    clean.href = href;
    clean.target = '_blank';
    clean.rel = 'noreferrer noopener';
    clean.appendChild(
      sanitizeMarkdownChildren(ownerDocument, element, attachments)
    );
    return clean;
  }

  if (tagName === 'img') {
    const src = resolveImageSrc(element.getAttribute('src'), attachments);
    if (!src) {
      return ownerDocument.createTextNode(
        `[image: ${element.getAttribute('alt') || 'image'}]`
      );
    }
    const clean = ownerDocument.createElement('img');
    clean.src = src;
    clean.alt = element.getAttribute('alt') || '';
    clean.loading = 'lazy';
    return clean;
  }

  const clean = ownerDocument.createElement(tagName);
  if (tagName === 'ol') {
    const start = element.getAttribute('start');
    if (start && /^\d+$/.test(start)) {
      clean.setAttribute('start', start);
    }
  }
  clean.appendChild(
    sanitizeMarkdownChildren(ownerDocument, element, attachments)
  );
  return clean;
}

function renderMessageMarkdown(
  target: HTMLElement,
  raw: string,
  threadTitlesById: Map<string, string> = new Map()
): void {
  const parsed = parseManagerMessage(raw);
  const markdown = humanizeThreadReferenceText(
    parsed.markdown,
    threadTitlesById
  );
  const html = String(marked.parse(markdown, { gfm: true, breaks: true }));
  const template = document.createElement('template');
  template.innerHTML = html;
  const attachments = new Map(
    parsed.attachments.map((attachment) => [attachment.id, attachment])
  );
  const sanitized = sanitizeMarkdownChildren(
    document,
    template.content,
    attachments
  );
  renderAnsiTextNodes(sanitized);
  target.replaceChildren(sanitized);
}

function makeStateBadge(state: ManagerUiState): HTMLSpanElement {
  const badge = document.createElement('span');
  const style = STATE_STYLES[state];
  badge.className = 'state-badge';
  badge.textContent = STATE_LABELS[state];
  badge.style.background = style.bg;
  badge.style.color = style.color;
  badge.style.borderColor = style.border;
  return badge;
}

function makeBubble(
  message: Msg,
  threadTitlesById: Map<string, string>
): HTMLDivElement {
  const bubble = document.createElement('div');
  const ai = message.sender === 'ai';
  bubble.className = `bubble ${ai ? 'bubble-ai' : 'bubble-user'}`;
  if (message.live) {
    bubble.classList.add('bubble-live');
  }
  bubble.dataset.messageKey =
    message.key ??
    `${message.sender}|${message.at ?? ''}|${hashMessageContent(message.content)}`;
  bubble.dataset.chatSide = ai ? 'left' : 'right';
  bubble.dataset.sender = message.sender;

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';

  const sender = document.createElement('span');
  sender.className = `bubble-sender ${ai ? 'bubble-sender-ai' : 'bubble-sender-user'}`;
  sender.textContent = message.senderLabel ?? (ai ? 'AI' : 'あなた');

  const timestamp = document.createElement('span');
  timestamp.className = 'bubble-ts';
  timestamp.textContent = message.live
    ? message.at
      ? `${message.provisional ? '確定前 / ' : ''}ライブ更新 / ${formatDate(message.at)}`
      : message.provisional
        ? '確定前 / ライブ更新'
        : 'ライブ更新'
    : formatDate(message.at);

  const content = document.createElement('div');
  content.className = 'bubble-content';
  renderMessageMarkdown(
    content,
    message.content,
    message.sender === 'ai' ? threadTitlesById : new Map()
  );

  meta.append(sender, timestamp);
  bubble.append(meta, content);
  return bubble;
}

function buildLiveWorkerMessage(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): Msg | null {
  const activity = describeLiveActivity(thread, threadTitlesById);
  if (!activity) {
    return null;
  }

  const content =
    activity.steps
      .map((entry) => entry.text)
      .join('\n\n')
      .trim() ||
    activity.headline ||
    GENERIC_LIVE_PROGRESS_TEXT;
  const lastPersisted = thread.messages.at(-1);
  if (
    lastPersisted?.sender === 'ai' &&
    lastPersisted.content.trim() === content.trim()
  ) {
    return null;
  }

  return {
    sender: 'ai',
    content,
    at: activity.updatedAt ?? thread.updatedAt,
    live: true,
    provisional: true,
    senderLabel: activity.actorLabel,
    key: `live:${thread.id}`,
  };
}

function messagesForDetail(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): Msg[] {
  const messages = [...thread.messages];
  const liveMessage = buildLiveWorkerMessage(thread, threadTitlesById);
  if (liveMessage) {
    messages.push(liveMessage);
  }
  return messages;
}

function makeFeedbackChip(
  label: string,
  onClick?: () => void
): HTMLButtonElement | HTMLSpanElement {
  if (!onClick) {
    const chip = document.createElement('span');
    chip.className = 'composer-chip';
    chip.textContent = label;
    return chip;
  }

  const chip = document.createElement('button');
  chip.className = 'composer-chip';
  chip.textContent = label;
  chip.type = 'button';
  chip.addEventListener('click', onClick);
  return chip;
}

function makeFeedbackStateBadge(
  status: ComposerFeedbackStatus
): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = 'composer-feedback-state';
  switch (status) {
    case 'sending':
      badge.textContent = '送信中';
      badge.style.background = 'rgba(43, 141, 228, 0.12)';
      badge.style.color = '#1660b8';
      break;
    case 'retrying':
      badge.textContent = '自動再送';
      badge.style.background = 'rgba(217, 119, 6, 0.12)';
      badge.style.color = '#b45309';
      break;
    case 'sent':
      badge.textContent = '送信済み';
      badge.style.background = 'rgba(6, 199, 85, 0.12)';
      badge.style.color = '#0f7a3e';
      break;
    case 'failed':
      badge.textContent = '送信失敗';
      badge.style.background = 'rgba(220, 38, 38, 0.12)';
      badge.style.color = '#b42318';
      break;
  }
  return badge;
}

function describeThreadState(thread: ThreadView): string | null {
  if (thread.seedRecoveryPending) {
    return (
      thread.workerRuntimeDetail ??
      '対象 repo の seed worktree に tracked changes があるため止まっています。下の「退避して続行」で一時退避すると再開できます。'
    );
  }
  if (thread.workerRuntimeState === 'cancelled-as-superseded') {
    return (
      thread.workerRuntimeDetail ??
      'より新しい派生作業で全面的に置き換わるため、この作業項目の worker agent は停止しました。'
    );
  }
  if (thread.workerRuntimeState === 'blocked-by-scope') {
    return (
      thread.workerRuntimeDetail ??
      '別の worker agent と書き込み範囲が重なるため、いまは待機しています。'
    );
  }
  if (thread.workerRuntimeState === 'manager-answering') {
    return (
      thread.workerRuntimeDetail ??
      'Manager がこの作業項目を直接処理しています。'
    );
  }
  if (thread.workerRuntimeState === 'manager-recovery') {
    return (
      thread.workerRuntimeDetail ??
      'Manager がレビュー結果を分析し、回復方法を決定しています。'
    );
  }
  if (thread.workerRuntimeState === 'worker-running') {
    return (
      thread.workerRuntimeDetail ??
      '担当 worker agent がこの作業項目を実行中です。'
    );
  }
  if (thread.routingConfirmationNeeded) {
    return 'この work item だけ、どの work item として扱うかをあなたに確認したい状態です。';
  }
  if (thread.uiState === 'user-reply-needed') {
    return 'AI が続きに必要な確認を待っています。返事をすると上から優先的に処理します。';
  }
  if (thread.uiState === 'ai-finished-awaiting-user-confirmation') {
    return 'AI の中では一区切りついています。内容を確認して、追加があればそのまま送り、終わりなら完了にしてください。';
  }
  if (thread.uiState === 'ai-working') {
    return 'いま AI がこの作業項目を実行中です。結果が返ると自動で上の優先度へ移動します。';
  }
  if (thread.uiState === 'queued') {
    return 'いまは AI の順番待ちです。順番が来ると、そのまま自動で作業に入ります。';
  }
  if (thread.uiState === 'done') {
    return 'この作業項目は完了として閉じています。必要ならもう一度開けます。';
  }
  return null;
}

function threadNextActionText(thread: ThreadView): string {
  if (thread.seedRecoveryPending) {
    return '下の「退避して続行」で seed の tracked changes を一時退避すると、この依頼を再開できます。';
  }
  if (thread.routingConfirmationNeeded) {
    return 'この件の扱い方だけ先に確認して返します。';
  }
  if (thread.uiState === 'user-reply-needed') {
    return '必要な確認に返すと、そのまま続きへ戻せます。';
  }
  if (thread.uiState === 'ai-finished-awaiting-user-confirmation') {
    return '内容を見て、続きがあればそのまま送り、終わりなら完了にします。';
  }
  if (thread.uiState === 'ai-working') {
    return 'いまは結果待ちです。急ぎならこの件を開いて追加指示を送れます。';
  }
  if (thread.uiState === 'queued') {
    return 'このまま待てば順番に進みます。';
  }
  if (thread.uiState === 'cancelled-as-superseded') {
    return '新しい派生先へ置き換わったので、必要なら関連先を確認します。';
  }
  if (thread.uiState === 'done') {
    return '必要なら開き直して続けられます。';
  }
  return 'この件を開けば、必要な情報と次の操作をその場で確認できます。';
}

function summarizeSeedRecoveryFiles(files: string[], maxItems = 6): string[] {
  if (files.length <= maxItems) {
    return files;
  }
  return [...files.slice(0, maxItems), `他 ${files.length - maxItems} 件`];
}

function threadMetaChipTexts(
  thread: ThreadView,
  threadsById: Map<string, ThreadView>
): string[] {
  const chips: string[] = [];
  if (thread.managedRepoLabel) {
    chips.push(
      thread.repoTargetKind === 'new-repo'
        ? `new repo: ${thread.managedRepoLabel}`
        : `repo: ${thread.managedRepoLabel}`
    );
  }
  if (thread.requestedRunMode) {
    chips.push(`mode: ${humanizeRunMode(thread.requestedRunMode)}`);
  }
  if (thread.managedVerifyCommand) {
    chips.push(`verify: ${thread.managedVerifyCommand}`);
  }
  if (thread.requestedWorkerRuntime) {
    chips.push(
      `runtime: ${humanizeWorkerRuntime(thread.requestedWorkerRuntime)}`
    );
  }
  const relation = describeWorkItemRelations(thread, threadsById);
  if (relation) {
    chips.push(relation);
  }
  return chips;
}

function detailContextSummary(
  thread: ThreadView,
  threadsById: Map<string, ThreadView>
): string | null {
  const parts = [
    thread.managedRepoLabel
      ? [
          thread.repoTargetKind === 'new-repo'
            ? `new repo: ${thread.managedRepoLabel}`
            : `repo: ${thread.managedRepoLabel}`,
          thread.managedBaseBranch ? `base: ${thread.managedBaseBranch}` : '',
          thread.requestedRunMode
            ? `mode: ${humanizeRunMode(thread.requestedRunMode)}`
            : '',
          thread.requestedWorkerRuntime
            ? `runtime: ${humanizeWorkerRuntime(thread.requestedWorkerRuntime)}`
            : '',
        ]
          .filter(Boolean)
          .join(' / ')
      : null,
    thread.managedVerifyCommand
      ? `verify: ${thread.managedVerifyCommand}`
      : null,
    describeWorkItemRelations(thread, threadsById),
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length > 0 ? parts.join(' / ') : null;
}

function makeDetailSummaryCard(
  label: string,
  title: string,
  copy: string
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'detail-summary-card';
  card.dataset.detailSummaryCard = '';

  const labelEl = document.createElement('div');
  labelEl.className = 'detail-summary-label';
  labelEl.textContent = label;

  const titleEl = document.createElement('div');
  titleEl.className = 'detail-summary-title';
  titleEl.textContent = title;

  const copyEl = document.createElement('div');
  copyEl.className = 'detail-summary-copy';
  copyEl.textContent = copy;

  card.append(labelEl, titleEl, copyEl);
  return card;
}

function activityPriorityThreads(threads: ThreadView[]): ThreadView[] {
  return [...threads]
    .filter((thread) => thread.uiState !== 'done')
    .sort((left, right) => {
      const rankDiff =
        STATE_PRIORITY_RANK[left.uiState] - STATE_PRIORITY_RANK[right.uiState];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return compareThreadsByUpdatedAt(left, right, 'newest-first');
    });
}

function makeActivityFocusCard(
  thread: ThreadView,
  threadTitlesById: Map<string, string>,
  threadsById: Map<string, ThreadView>,
  onClick: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'activity-focus-card';
  button.type = 'button';
  button.addEventListener('click', onClick);

  const top = document.createElement('div');
  top.className = 'activity-focus-card-top';
  top.append(
    makeStateBadge(thread.uiState),
    Object.assign(document.createElement('span'), {
      className: 'activity-focus-card-title',
      textContent: thread.title,
    })
  );

  const copy = document.createElement('div');
  copy.className = 'activity-focus-card-copy';
  copy.textContent = threadNextActionText(thread);

  const meta = document.createElement('div');
  meta.className = 'activity-focus-card-meta';
  meta.textContent = [
    rowActivityText(thread, threadTitlesById),
    detailContextSummary(thread, threadsById),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => humanizeThreadReferenceText(value, threadTitlesById))
    .join(' / ');

  button.append(top, copy);
  if (meta.textContent) {
    button.appendChild(meta);
  }
  return button;
}

function isCoarsePointerDevice(): boolean {
  try {
    return (
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(hover: none)').matches
    );
  } catch {
    return false;
  }
}

function managerStatusBusy(status: ManagerStatusPayload | null): boolean {
  if (!status?.running) {
    return false;
  }
  if (status.currentThreadId) {
    return true;
  }
  return status.detail?.includes('処理中') ?? false;
}

function managerStatusProblem(
  status: ManagerStatusPayload | null
): 'error' | 'paused' | null {
  const health = status?.health ?? 'ok';
  if (health === 'error' || health === 'paused') {
    return health;
  }
  return null;
}

function threadStateLocation(thread: ThreadView): string {
  return `一覧では「${STATE_LABELS[thread.uiState]}」にあります`;
}

function pendingThreadActionLabel(action: ThreadMutationAction): string {
  return action === 'resolve' ? '完了にしています…' : '開き直しています…';
}

function applyOptimisticThreadMutation(
  thread: ThreadView,
  mutation: PendingThreadMutation
): ThreadView {
  if (mutation.action === 'resolve') {
    return {
      ...thread,
      status: 'resolved',
      uiState: 'done',
      hiddenByDefault: true,
      routingConfirmationNeeded: false,
      queueDepth: 0,
      isWorking: false,
      assigneeKind: null,
      assigneeLabel: null,
      workerAgentId: null,
      workerRuntimeState: null,
      workerRuntimeDetail: null,
      workerBlockedByThreadIds: [],
      supersededByThreadId: null,
    };
  }

  const nextUiState =
    thread.lastSender === 'ai'
      ? 'ai-finished-awaiting-user-confirmation'
      : 'queued';
  const nextStatus = thread.lastSender === 'ai' ? 'review' : 'waiting';
  return {
    ...thread,
    status: nextStatus,
    uiState: nextUiState,
    hiddenByDefault: false,
    routingConfirmationNeeded: false,
    queueDepth: 0,
    isWorking: false,
    assigneeKind: null,
    assigneeLabel: null,
    workerAgentId: null,
    workerRuntimeState: null,
    workerRuntimeDetail: null,
    workerBlockedByThreadIds: [],
    supersededByThreadId: null,
  };
}

function summarizeRelationTitles(titles: string[]): string {
  if (titles.length <= 2) {
    return titles.join('、');
  }
  return `${titles.slice(0, 2).join('、')} ほか${titles.length - 2}件`;
}

function collectRelatedThreads(
  threadIds: string[],
  threadsById: Map<string, ThreadView>
): ThreadView[] {
  const related: ThreadView[] = [];
  const seen = new Set<string>();
  for (const threadId of threadIds) {
    if (seen.has(threadId)) {
      continue;
    }
    const thread = threadsById.get(threadId);
    if (!thread) {
      continue;
    }
    seen.add(threadId);
    related.push(thread);
  }
  return related;
}

function summarizeChildStateBreakdown(threads: ThreadView[]): string | null {
  if (threads.length === 0) {
    return null;
  }

  const doneCount = threads.filter(
    (thread) => thread.uiState === 'done'
  ).length;
  const openCount = threads.length - doneCount;
  return `未完了 ${openCount} / 完了 ${doneCount}`;
}

function describeWorkItemRelations(
  thread: ThreadView,
  threadsById: Map<string, ThreadView>
): string | null {
  const parentThreads = collectRelatedThreads(
    thread.derivedFromThreadIds ?? [],
    threadsById
  );
  const childThreads = collectRelatedThreads(
    thread.derivedChildThreadIds ?? [],
    threadsById
  );
  const parts: string[] = [];
  if (parentThreads.length > 0) {
    parts.push(
      `派生元: ${summarizeRelationTitles(parentThreads.map((item) => item.title))}`
    );
  }
  if (childThreads.length > 0) {
    const breakdown = summarizeChildStateBreakdown(childThreads);
    parts.push(
      [
        `派生先: ${summarizeRelationTitles(childThreads.map((item) => item.title))}`,
        breakdown,
      ]
        .filter(Boolean)
        .join(' / ')
    );
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

function describeWorkItemContext(
  thread: ThreadView,
  threadsById: Map<string, ThreadView>
): string | null {
  const parts = [
    thread.managedRepoLabel
      ? [
          thread.repoTargetKind === 'new-repo'
            ? `new repo: ${thread.managedRepoLabel}`
            : `repo: ${thread.managedRepoLabel}`,
          thread.managedBaseBranch ? `base: ${thread.managedBaseBranch}` : '',
          `mode: ${humanizeRunMode(thread.requestedRunMode)}`,
        ]
          .filter(Boolean)
          .join(' / ')
      : null,
    describeWorkItemRelations(thread, threadsById),
    thread.routingHint,
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length > 0 ? parts.join(' / ') : null;
}

function workerRuntimeLabel(thread: ThreadView): string | null {
  switch (thread.workerRuntimeState) {
    case 'manager-answering':
      return 'Manager が直接処理中';
    case 'manager-recovery':
      return 'Manager が回復対応中';
    case 'worker-running':
      return 'Worker agent 実行中';
    case 'blocked-by-scope':
      return '書き込み範囲の競合で待機中';
    case 'cancelled-as-superseded':
      return '置き換えで停止';
    default:
      return null;
  }
}

function rowPreviewText(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): string {
  const activity = describeLiveActivity(thread, threadTitlesById);
  if (thread.uiState === 'ai-working' && activity?.headline) {
    return `${activity.actorLabel}: ${activity.headline}`;
  }
  return (
    humanizeThreadReferenceText(thread.previewText, threadTitlesById) ||
    'まだやり取りはありません'
  );
}

function rowActivityText(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): string | null {
  const activity = describeLiveActivity(thread, threadTitlesById);
  if (!activity) {
    return null;
  }
  const parts = [
    activity.actorLabel,
    activity.runtimeLabel,
    activity.updatedLabel,
  ].filter((value): value is string => Boolean(value?.trim()));
  return parts.length > 0 ? parts.join(' / ') : null;
}

function makeLiveActivityPanel(
  thread: ThreadView,
  threadTitlesById: Map<string, string>
): HTMLElement | null {
  const activity = describeLiveActivity(thread, threadTitlesById);
  if (!activity) {
    return null;
  }

  const panel = document.createElement('section');
  panel.className = 'detail-live-activity';
  panel.dataset.liveActivityPanel = '';

  const header = document.createElement('div');
  header.className = 'detail-live-activity-header';

  const title = document.createElement('div');
  title.className = 'detail-live-activity-title';
  title.textContent = 'いまの活動';

  const chips = document.createElement('div');
  chips.className = 'detail-live-activity-chips';
  for (const value of [
    activity.actorLabel,
    activity.runtimeLabel,
    activity.updatedLabel,
  ]) {
    if (!value) {
      continue;
    }
    const chip = document.createElement('span');
    chip.className = 'detail-live-activity-chip';
    chip.textContent = value;
    chips.appendChild(chip);
  }
  header.append(title, chips);
  panel.appendChild(header);

  if (activity.headline) {
    const summary = document.createElement('div');
    summary.className = 'detail-live-activity-summary';
    summary.textContent = activity.headline;
    panel.appendChild(summary);
  }

  if (
    activity.runtimeDetail &&
    activity.headline &&
    activity.runtimeDetail !== activity.headline
  ) {
    const stage = document.createElement('div');
    stage.className = 'detail-live-activity-stage';
    stage.textContent = `現在の段階: ${activity.runtimeDetail}`;
    panel.appendChild(stage);
  }

  const steps = activity.steps;
  if (steps.length > 0) {
    const list = document.createElement('div');
    list.className = 'detail-live-activity-list';
    list.dataset.liveActivityList = '';
    for (const step of steps) {
      const item = document.createElement('div');
      item.className = 'detail-live-activity-item';

      const badge = document.createElement('span');
      badge.className = 'detail-live-activity-kind';
      badge.textContent =
        step.kind === 'output'
          ? '内容'
          : step.kind === 'error'
            ? '異常'
            : '状況';

      const text = document.createElement('div');
      text.className = 'detail-live-activity-item-text';
      text.textContent = step.text;

      const meta = document.createElement('span');
      meta.className = 'detail-live-activity-item-time';
      meta.textContent = step.at ? formatDate(step.at) : '';

      item.append(badge, text, meta);
      list.appendChild(item);
    }
    panel.appendChild(list);
  }

  return panel;
}

function currentBusyThread(
  threads: ThreadView[],
  status: ManagerStatusPayload | null
): ThreadView | null {
  if (status?.currentThreadId) {
    return (
      threads.find((thread) => thread.id === status.currentThreadId) ?? null
    );
  }
  return threads.find((thread) => thread.uiState === 'ai-working') ?? null;
}

function currentBusySummary(
  threads: ThreadView[],
  status: ManagerStatusPayload | null,
  threadTitlesById: Map<string, string>
): string | null {
  const thread = currentBusyThread(threads, status);
  if (!thread) {
    return null;
  }
  const activity = describeLiveActivity(thread, threadTitlesById);
  if (!activity?.headline) {
    return null;
  }
  const prefix = activity.actorLabel ? `${activity.actorLabel}: ` : '';
  return truncateText(`${prefix}${activity.headline}`, 88);
}

function makeRelatedWorkItemButton(
  thread: ThreadView,
  threadTitlesById: Map<string, string>,
  onClick: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'detail-related-item btn-ghost';
  button.type = 'button';
  button.addEventListener('click', onClick);

  const top = document.createElement('div');
  top.className = 'detail-related-item-top';
  top.append(
    makeStateBadge(thread.uiState),
    Object.assign(document.createElement('span'), {
      className: 'detail-related-item-title',
      textContent: thread.title,
    })
  );

  const meta = document.createElement('div');
  meta.className = 'detail-related-item-meta';
  meta.textContent = [
    humanizeThreadReferenceText(thread.previewText, threadTitlesById),
    thread.uiState === 'done' ? '完了済み' : '未完了',
  ]
    .filter(Boolean)
    .join(' / ');

  button.append(top, meta);
  return button;
}

function composerActionLabel(
  thread: ThreadView,
  openThread: ThreadView | null
): string {
  if (openThread && thread.id === openThread.id) {
    return thread.uiState === 'ai-working'
      ? 'この会話へ追加指示を送る'
      : 'この会話へ送る';
  }
  return thread.uiState === 'ai-working'
    ? 'この会話をメンションして追加指示を送る'
    : 'この会話をメンションして送る';
}

function composerSendButtonLabel(thread: ThreadView | null): string {
  if (!thread) {
    return '送る';
  }
  return thread.uiState === 'ai-working' ? '追加指示を送る' : '送る';
}

function composerTargetPillLabel(
  thread: ThreadView | null,
  openThread: ThreadView | null
): string {
  if (!thread) {
    return openThread && openThread.uiState !== 'done'
      ? '送信先: 全体（別件）'
      : '送信先: 全体（AI が振り分けます）';
  }
  if (openThread && thread.id === openThread.id) {
    return thread.uiState === 'ai-working'
      ? '送信先: この会話（追加指示）'
      : '送信先: この会話';
  }
  return thread.uiState === 'ai-working'
    ? `送信先: @${thread.title}（続きなら追加指示）`
    : `送信先: @${thread.title}`;
}

function composerTargetClearLabel(
  thread: ThreadView | null,
  openThread: ThreadView | null
): string | null {
  if (!thread) {
    return openThread && openThread.uiState !== 'done'
      ? 'この会話に戻す'
      : null;
  }
  if (openThread && thread.id === openThread.id) {
    return '別件にする';
  }
  return openThread && openThread.uiState !== 'done'
    ? 'この会話に戻す'
    : '全体へ戻す';
}

function composerRetryDelayMs(attemptCount: number): number {
  const index = Math.max(
    0,
    Math.min(COMPOSER_SEND_RETRY_DELAYS_MS.length - 1, attemptCount - 1)
  );
  return COMPOSER_SEND_RETRY_DELAYS_MS[index] ?? 30000;
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs <= 0) {
    return 'すぐに';
  }
  const seconds = Math.max(1, Math.round(delayMs / 1000));
  return `${seconds}秒後に`;
}

function composerRetryDetailText(
  attemptCount: number,
  delayMs: number
): string {
  const attemptLabel = `${attemptCount}回目`;
  if (delayMs <= 0) {
    return `送信エラーのため自動再送しています… (${attemptLabel})`;
  }
  return `送信エラーのため${formatRetryDelay(delayMs)}自動再送します。 (${attemptLabel})`;
}

function feedbackLaneSummaryText(entries: ComposerFeedbackEntry[]): string {
  const counts = {
    sending: 0,
    retrying: 0,
    sent: 0,
    failed: 0,
  };
  for (const entry of entries) {
    counts[entry.status] += 1;
  }
  return [
    counts.sending > 0 ? `送信中 ${counts.sending}件` : null,
    counts.retrying > 0 ? `自動再送 ${counts.retrying}件` : null,
    counts.sent > 0 ? `送信済み ${counts.sent}件` : null,
    counts.failed > 0 ? `送信失敗 ${counts.failed}件` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' / ');
}

class ThreadSectionController {
  #key: ManagerUiState;
  #section: HTMLElement | null;
  #header: HTMLElement | null;
  #body: HTMLElement | null;
  #count: HTMLElement | null;
  #chevron: HTMLElement | null;
  #collapsed = true;
  #rows = new Map<string, HTMLElement>();
  #orderedIds: string[] = [];
  #lastThreads: ThreadView[] = [];
  #lastThreadCount = 0;
  #lastOpenThreadId: string | null = null;
  #lastTargetThreadId: string | null = null;
  #lastSelectHandler: ((id: string) => void) | null = null;
  #lastThreadTitlesById = new Map<string, string>();
  #lastThreadsById = new Map<string, ThreadView>();

  constructor(key: ManagerUiState) {
    this.#key = key;
    this.#section = document.getElementById(`sec-${key}`);
    this.#header = document.querySelector(
      `[data-section-key="${key}"]`
    ) as HTMLElement | null;
    this.#body = document.getElementById(`body-${key}`);
    this.#count = document.getElementById(`count-${key}`);
    this.#chevron = document.getElementById(`chevron-${key}`);
    this.setCollapsed(true);
  }

  getRow(threadId: string): HTMLElement | null {
    return this.#rows.get(threadId) ?? null;
  }

  #setHidden(hidden: boolean): void {
    this.#section?.classList.toggle('hidden', hidden);
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    if (this.#body) {
      this.#body.style.display = collapsed ? 'none' : '';
    }
    if (this.#chevron) {
      this.#chevron.textContent = collapsed ? '▼' : '▲';
    }
    this.#header?.setAttribute('aria-expanded', String(!collapsed));
  }

  toggle(): void {
    this.setCollapsed(!this.#collapsed);
    if (!this.#collapsed) {
      this.update(
        this.#lastThreads,
        this.#lastOpenThreadId,
        this.#lastTargetThreadId,
        this.#lastSelectHandler,
        this.#lastThreadTitlesById,
        this.#lastThreadsById
      );
    }
  }

  update(
    threads: ThreadView[],
    openThreadId: string | null,
    targetThreadId: string | null,
    onSelect: ((id: string) => void) | null,
    threadTitlesById: Map<string, string>,
    threadsById: Map<string, ThreadView>
  ): void {
    this.#lastThreads = threads;
    this.#lastOpenThreadId = openThreadId;
    this.#lastTargetThreadId = targetThreadId;
    this.#lastSelectHandler = onSelect;
    this.#lastThreadTitlesById = threadTitlesById;
    this.#lastThreadsById = threadsById;
    const previousCount = this.#lastThreadCount;
    this.#lastThreadCount = threads.length;
    const hasThreads = threads.length > 0;

    this.#setHidden(!hasThreads);

    if (!hasThreads) {
      this.setCollapsed(true);
    } else if (previousCount === 0) {
      this.setCollapsed(false);
    }

    if (this.#count) {
      this.#count.textContent = hasThreads ? `(${threads.length})` : '';
    }
    if (!hasThreads) {
      this.#body?.querySelector('.section-empty')?.remove();
      return;
    }
    if (!this.#body || this.#collapsed) {
      return;
    }

    const nextIds = threads.map((thread) => thread.id);
    const existingEmpty = this.#body.querySelector('.section-empty');

    for (const id of this.#orderedIds) {
      if (!nextIds.includes(id)) {
        const row = this.#rows.get(id);
        row?.remove();
        this.#rows.delete(id);
      }
    }

    existingEmpty?.remove();

    for (const thread of threads) {
      const existing = this.#rows.get(thread.id);
      if (existing) {
        this.#patchRow(
          existing,
          thread,
          openThreadId,
          targetThreadId,
          threadTitlesById,
          threadsById
        );
      } else {
        this.#rows.set(
          thread.id,
          this.#buildRow(
            thread,
            openThreadId,
            targetThreadId,
            onSelect,
            threadTitlesById,
            threadsById
          )
        );
      }
    }

    for (let index = 0; index < nextIds.length; index += 1) {
      const row = this.#rows.get(nextIds[index]);
      if (!row) continue;
      const currentAtIndex = this.#body.children[index];
      if (currentAtIndex !== row) {
        this.#body.insertBefore(row, currentAtIndex || null);
      }
    }

    this.#orderedIds = nextIds;
  }

  #buildRow(
    thread: ThreadView,
    openThreadId: string | null,
    targetThreadId: string | null,
    onSelect: ((id: string) => void) | null,
    threadTitlesById: Map<string, string>,
    threadsById: Map<string, ThreadView>
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'thread-row';
    row.dataset.threadId = thread.id;
    if (openThreadId === thread.id) {
      row.classList.add('selected');
      row.classList.add('thread-row-open');
    }

    const top = document.createElement('div');
    top.className = 'thread-row-top';

    const badge = makeStateBadge(thread.uiState);
    badge.dataset.rowBadge = '';

    const title = document.createElement('div');
    title.className = 'thread-title';
    title.dataset.rowTitle = '';
    title.textContent = thread.title;

    const age = document.createElement('div');
    age.className = 'thread-age';
    age.dataset.rowAge = '';
    age.textContent = formatAge(thread.updatedAt);

    const detailToggle = document.createElement('span');
    detailToggle.className = 'thread-open-indicator';
    detailToggle.dataset.rowToggle = '';
    detailToggle.textContent =
      openThreadId === thread.id ? '表示中' : '会話を開く';

    const target = document.createElement('span');
    target.className = 'thread-open-indicator thread-target-indicator';
    target.dataset.rowTarget = '';
    target.textContent = '送信先';
    target.classList.toggle('hidden', targetThreadId !== thread.id);

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.dataset.rowPreview = '';
    preview.textContent = rowPreviewText(thread, threadTitlesById);

    top.append(badge, title, age, target, detailToggle);
    row.append(top, preview);

    const step = document.createElement('div');
    step.className = 'thread-step';
    step.dataset.rowStep = '';
    step.textContent = threadNextActionText(thread);
    row.appendChild(step);

    const metaChipTexts = threadMetaChipTexts(thread, threadsById);
    if (metaChipTexts.length > 0) {
      const chips = document.createElement('div');
      chips.className = 'thread-meta-chips';
      chips.dataset.rowMetaChips = '';
      for (const value of metaChipTexts) {
        const chip = document.createElement('span');
        chip.className = 'thread-meta-chip';
        chip.textContent = value;
        chips.appendChild(chip);
      }
      row.appendChild(chips);
    }

    const activityText = rowActivityText(thread, threadTitlesById);
    if (activityText) {
      const activity = document.createElement('div');
      activity.className = 'thread-activity';
      activity.dataset.rowActivity = '';
      activity.textContent = activityText;
      row.appendChild(activity);
    }

    const noteText = describeWorkItemContext(thread, threadsById);
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'thread-note';
      note.dataset.rowNote = '';
      note.textContent = humanizeThreadReferenceText(
        noteText,
        threadTitlesById
      );
      row.appendChild(note);
    }

    row.addEventListener('click', () => {
      onSelect?.(thread.id);
    });
    return row;
  }

  #patchRow(
    row: HTMLElement,
    thread: ThreadView,
    openThreadId: string | null,
    targetThreadId: string | null,
    threadTitlesById: Map<string, string>,
    threadsById: Map<string, ThreadView>
  ): void {
    row.classList.toggle('selected', openThreadId === thread.id);
    row.classList.toggle('thread-row-open', openThreadId === thread.id);

    const badge = row.querySelector<HTMLElement>('[data-row-badge]');
    if (badge) {
      const next = makeStateBadge(thread.uiState);
      badge.textContent = next.textContent;
      badge.style.background = next.style.background;
      badge.style.color = next.style.color;
      badge.style.borderColor = next.style.borderColor;
    }

    const title = row.querySelector<HTMLElement>('[data-row-title]');
    if (title && title.textContent !== thread.title) {
      title.textContent = thread.title;
    }

    const age = row.querySelector<HTMLElement>('[data-row-age]');
    if (age) {
      age.textContent = formatAge(thread.updatedAt);
    }

    const toggle = row.querySelector<HTMLElement>('[data-row-toggle]');
    if (toggle) {
      toggle.textContent = openThreadId === thread.id ? '表示中' : '会話を開く';
    }

    const target = row.querySelector<HTMLElement>('[data-row-target]');
    target?.classList.toggle('hidden', targetThreadId !== thread.id);

    const preview = row.querySelector<HTMLElement>('[data-row-preview]');
    const nextPreview = rowPreviewText(thread, threadTitlesById);
    if (preview && preview.textContent !== nextPreview) {
      preview.textContent = nextPreview;
    }

    const step = row.querySelector<HTMLElement>('[data-row-step]');
    const nextStepText = threadNextActionText(thread);
    if (step && step.textContent !== nextStepText) {
      step.textContent = nextStepText;
    }

    const nextMetaChipTexts = threadMetaChipTexts(thread, threadsById);
    let chips = row.querySelector<HTMLElement>('[data-row-meta-chips]');
    if (nextMetaChipTexts.length > 0) {
      if (!chips) {
        chips = document.createElement('div');
        chips.className = 'thread-meta-chips';
        chips.dataset.rowMetaChips = '';
        const activity = row.querySelector<HTMLElement>('[data-row-activity]');
        if (activity) {
          row.insertBefore(chips, activity);
        } else {
          row.appendChild(chips);
        }
      }
      chips.innerHTML = '';
      for (const value of nextMetaChipTexts) {
        const chip = document.createElement('span');
        chip.className = 'thread-meta-chip';
        chip.textContent = value;
        chips.appendChild(chip);
      }
    } else {
      chips?.remove();
    }

    let activity = row.querySelector<HTMLElement>('[data-row-activity]');
    const nextActivityText = rowActivityText(thread, threadTitlesById);
    if (nextActivityText) {
      if (!activity) {
        activity = document.createElement('div');
        activity.className = 'thread-activity';
        activity.dataset.rowActivity = '';
        preview?.insertAdjacentElement('afterend', activity);
      }
      activity.textContent = nextActivityText;
    } else {
      activity?.remove();
    }

    let note = row.querySelector<HTMLElement>('[data-row-note]');
    const noteText = describeWorkItemContext(thread, threadsById);
    if (noteText) {
      if (!note) {
        note = document.createElement('div');
        note.className = 'thread-note';
        note.dataset.rowNote = '';
        row.appendChild(note);
      }
      note.textContent = humanizeThreadReferenceText(
        noteText,
        threadTitlesById
      );
    } else {
      note?.remove();
    }
  }
}

class TaskSectionController {
  #body = document.getElementById('body-tasks');
  #count = document.getElementById('count-tasks');
  #chevron = document.getElementById('chevron-tasks');
  #header = document.querySelector(
    '[data-section-key="tasks"]'
  ) as HTMLElement | null;
  #collapsed = false;
  #lastTasks: Task[] = [];
  #lastSortOrder: ManagerListSortOrder = DEFAULT_MANAGER_SORT_ORDERS.tasks;

  toggle(): void {
    this.#collapsed = !this.#collapsed;
    if (this.#body) {
      this.#body.style.display = this.#collapsed ? 'none' : '';
    }
    if (this.#chevron) {
      this.#chevron.textContent = this.#collapsed ? '▼' : '▲';
    }
    this.#header?.setAttribute('aria-expanded', String(!this.#collapsed));
    if (!this.#collapsed) {
      this.render(this.#lastTasks, this.#lastSortOrder);
    }
  }

  render(tasks: Task[], sortOrder: ManagerListSortOrder): void {
    this.#lastTasks = tasks;
    this.#lastSortOrder = sortOrder;
    if (this.#count) {
      this.#count.textContent = tasks.length > 0 ? `(${tasks.length})` : '';
    }
    if (!this.#body || this.#collapsed) {
      return;
    }

    this.#body.innerHTML = '';
    const copy = document.createElement('div');
    copy.className = 'task-copy';
    copy.textContent =
      '作業項目の会話とは別に、このリポジトリ全体でまだ終わっていない作業メモを出します。いま自分が返す一覧ではありません。';
    this.#body.appendChild(copy);
    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'section-empty';
      empty.textContent = 'いま残っている作業メモはありません';
      this.#body.appendChild(empty);
      return;
    }

    const sorted = sortTasksByUpdatedAt(tasks, sortOrder);

    for (const task of sorted) {
      const row = document.createElement('div');
      row.className = 'task-row';

      const stage = document.createElement('span');
      stage.className = 'state-badge';
      stage.textContent = humanizeTaskStage(task.stage);
      stage.style.background = 'rgba(30, 64, 175, 0.18)';
      stage.style.color = '#bfdbfe';
      stage.style.borderColor = 'rgba(96, 165, 250, 0.32)';

      const desc = document.createElement('div');
      desc.className = 'task-desc';
      desc.textContent = task.description || '説明がまだ付いていない作業メモ';

      const age = document.createElement('div');
      age.className = 'task-age';
      age.textContent = formatAge(task.updatedAt || task.createdAt);

      row.append(stage, desc, age);
      this.#body.appendChild(row);
    }
  }
}

interface BuildEntry {
  commitHash: string;
  commitHashFull: string;
  commitMessage: string;
  commitDate: string;
  archivedAt: string;
  version: string;
  distPath: string;
}

interface BuildsPayload {
  builds: BuildEntry[];
  currentHash: string;
}

class BuildSectionController {
  #body = document.getElementById('body-builds');
  #count = document.getElementById('count-builds');
  #chevron = document.getElementById('chevron-builds');
  #header = document.querySelector(
    '[data-section-key="builds"]'
  ) as HTMLElement | null;
  #collapsed = true;
  #payload: BuildsPayload | null = null;
  #loaded = false;
  #onRollback: ((commitHash: string) => void) | null = null;
  #fetcher:
    | ((input: string, init?: RequestInit) => Promise<Response | null>)
    | null = null;

  setOnRollback(handler: (commitHash: string) => void): void {
    this.#onRollback = handler;
  }

  setFetcher(
    fetcher: (input: string, init?: RequestInit) => Promise<Response | null>
  ): void {
    this.#fetcher = fetcher;
  }

  toggle(): void {
    this.#collapsed = !this.#collapsed;
    if (this.#body) {
      this.#body.style.display = this.#collapsed ? 'none' : '';
    }
    if (this.#chevron) {
      this.#chevron.textContent = this.#collapsed ? '▼' : '▲';
    }
    this.#header?.setAttribute('aria-expanded', String(!this.#collapsed));
    if (!this.#collapsed && !this.#loaded && this.#fetcher) {
      this.#loaded = true;
      void this.load(this.#fetcher);
    }
  }

  async load(
    fetcher: (input: string, init?: RequestInit) => Promise<Response | null>
  ): Promise<void> {
    try {
      const response = await fetcher('/api/builds');
      if (!response || !response.ok) {
        return;
      }
      this.#payload = (await response.json()) as BuildsPayload;
      this.render();
    } catch {
      /* ignore */
    }
  }

  render(): void {
    const payload = this.#payload;
    if (this.#count) {
      this.#count.textContent =
        payload && payload.builds.length > 0
          ? `(${payload.builds.length})`
          : '';
    }
    if (!this.#body || this.#collapsed || !payload) {
      return;
    }

    this.#body.innerHTML = '';

    if (payload.builds.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'section-empty';
      empty.textContent =
        'アーカイブされたビルドはまだありません。restart で自動的に保存されます。';
      this.#body.appendChild(empty);
      return;
    }

    for (const build of payload.builds) {
      const isCurrent = build.commitHashFull === payload.currentHash;
      const row = document.createElement('div');
      row.className = isCurrent ? 'build-row build-current' : 'build-row';

      const info = document.createElement('div');
      info.className = 'build-info';

      const topLine = document.createElement('div');
      const hash = document.createElement('span');
      hash.className = 'build-hash';
      hash.textContent = build.commitHash;
      topLine.appendChild(hash);

      if (isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'build-current-badge';
        badge.textContent = ' (現在)';
        topLine.appendChild(badge);
      }
      info.appendChild(topLine);

      const msg = document.createElement('div');
      msg.className = 'build-message';
      msg.textContent = build.commitMessage;
      info.appendChild(msg);

      const date = document.createElement('div');
      date.className = 'build-date';
      date.textContent = new Date(build.archivedAt).toLocaleString();
      info.appendChild(date);

      row.appendChild(info);

      if (!isCurrent) {
        const btn = document.createElement('button');
        btn.className = 'btn-rollback';
        btn.textContent = 'ロールバック';
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          if (
            confirm(
              `ビルド ${build.commitHash} にロールバックしますか？\n${build.commitMessage}\n\nサーバーが再起動されます。`
            )
          ) {
            this.#onRollback?.(build.commitHashFull);
          }
        });
        row.appendChild(btn);
      }

      this.#body.appendChild(row);
    }
  }
}

class DetailController {
  #detailEl: HTMLElement;
  #app: ManagerApp;
  #currentThreadId: string | null = null;
  #lastRenderedSignature: string | null = null;

  constructor(detailEl: HTMLElement, app: ManagerApp) {
    this.#detailEl = detailEl;
    this.#app = app;
    this.#detailEl.addEventListener('click', (event) => {
      event.stopPropagation();
    });
  }

  get element(): HTMLElement {
    return this.#detailEl;
  }

  #captureScrollAnchor(msgArea: HTMLElement): {
    messageKey: string | null;
    offsetWithin: number;
  } | null {
    const bubbles = Array.from(
      msgArea.querySelectorAll<HTMLElement>('.bubble')
    );
    if (bubbles.length === 0) {
      return null;
    }

    const currentScrollTop = msgArea.scrollTop;
    const anchor =
      bubbles.find(
        (bubble) => bubble.offsetTop + bubble.offsetHeight > currentScrollTop
      ) ??
      bubbles[bubbles.length - 1] ??
      null;
    if (!anchor) {
      return null;
    }

    return {
      messageKey: anchor.dataset.messageKey ?? null,
      offsetWithin: currentScrollTop - anchor.offsetTop,
    };
  }

  #restoreScrollPosition(
    msgArea: HTMLElement,
    previousScrollTop: number | null,
    anchor: { messageKey: string | null; offsetWithin: number } | null
  ): void {
    if (anchor?.messageKey) {
      const escapedKey =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(anchor.messageKey)
          : anchor.messageKey.replace(/["\\]/g, '\\$&');
      const nextAnchor = msgArea.querySelector<HTMLElement>(
        `.bubble[data-message-key="${escapedKey}"]`
      );
      if (nextAnchor) {
        msgArea.scrollTop = Math.max(
          0,
          nextAnchor.offsetTop + anchor.offsetWithin
        );
        return;
      }
    }

    if (previousScrollTop !== null) {
      msgArea.scrollTop = previousScrollTop;
    }
  }

  #isNearBottom(msgArea: HTMLElement, threshold = 48): boolean {
    const viewportHeight = msgArea.clientHeight || msgArea.offsetHeight;
    if (viewportHeight <= 0) {
      return false;
    }
    if (msgArea.scrollHeight <= viewportHeight) {
      return false;
    }
    const remaining =
      msgArea.scrollHeight - (msgArea.scrollTop + viewportHeight);
    return remaining <= threshold;
  }

  #revealLatestMessage(msgArea: HTMLElement): void {
    const sync = () => {
      msgArea.scrollTop = msgArea.scrollHeight;
    };

    sync();
    const view = msgArea.ownerDocument.defaultView;
    view?.setTimeout(sync, 0);
  }

  render(
    thread: ThreadView | null,
    movementNotice: string | null,
    threadTitlesById: Map<string, string>,
    threadsById: Map<string, ThreadView>
  ): void {
    if (!thread) {
      this.clear();
      return;
    }

    const previousThreadId = this.#currentThreadId;
    const pendingAction = this.#app.pendingThreadAction(thread.id);
    const pendingSeedRecovery = this.#app.pendingSeedRecoveryAction(thread.id);
    const nextSignature = JSON.stringify({
      id: thread.id,
      title: thread.title,
      uiState: thread.uiState,
      pendingAction: pendingAction ?? '',
      pendingSeedRecovery,
      updatedAt: thread.updatedAt ?? '',
      queueDepth: thread.queueDepth,
      assigneeLabel: thread.assigneeLabel ?? '',
      workerAgentId: thread.workerAgentId ?? '',
      workerRuntimeState: thread.workerRuntimeState ?? '',
      workerRuntimeDetail: thread.workerRuntimeDetail ?? '',
      seedRecoveryPending: thread.seedRecoveryPending,
      seedRecoveryRepoLabel: thread.seedRecoveryRepoLabel ?? '',
      seedRecoveryRepoRoot: thread.seedRecoveryRepoRoot ?? '',
      seedRecoveryChangedFiles: thread.seedRecoveryChangedFiles,
      workerWriteScopes: thread.workerWriteScopes,
      workerBlockedByThreadIds: thread.workerBlockedByThreadIds,
      supersededByThreadId: thread.supersededByThreadId ?? '',
      workerLiveLog: thread.workerLiveLog.map((entry) => ({
        at: entry.at,
        text: entry.text,
        kind: entry.kind,
      })),
      workerLiveOutput: thread.workerLiveOutput ?? '',
      workerLiveAt: thread.workerLiveAt ?? '',
      movementNotice: movementNotice ?? '',
      messages: thread.messages.map((message) => ({
        sender: message.sender,
        content: message.content,
        at: message.at,
      })),
    });
    if (
      this.#currentThreadId === thread.id &&
      this.#lastRenderedSignature === nextSignature
    ) {
      return;
    }

    const previousMsgArea =
      this.#detailEl.querySelector<HTMLElement>('.msg-area');
    const sameThread = previousThreadId === thread.id;
    const preserveBottom =
      sameThread && previousMsgArea
        ? this.#isNearBottom(previousMsgArea)
        : false;
    const previousScrollTop =
      sameThread && previousMsgArea ? previousMsgArea.scrollTop : null;
    const previousAnchor =
      sameThread && previousMsgArea
        ? this.#captureScrollAnchor(previousMsgArea)
        : null;

    this.#currentThreadId = thread.id;
    this.#lastRenderedSignature = nextSignature;
    this.#detailEl.classList.remove('hidden');
    this.#detailEl.innerHTML = '';

    if (movementNotice) {
      const move = document.createElement('div');
      move.className = 'focus-move';
      move.textContent = movementNotice;
      this.#detailEl.appendChild(move);
    }

    const header = document.createElement('div');
    header.className = 'detail-header';

    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = thread.title;

    const badge = makeStateBadge(thread.uiState);

    header.append(title, badge);
    this.#detailEl.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.textContent = [
      thread.managedRepoLabel
        ? thread.repoTargetKind === 'new-repo'
          ? `new repo: ${thread.managedRepoLabel}`
          : `repo: ${thread.managedRepoLabel}`
        : '',
      thread.managedBaseBranch ? `base: ${thread.managedBaseBranch}` : '',
      thread.requestedRunMode
        ? `mode: ${humanizeRunMode(thread.requestedRunMode)}`
        : '',
      thread.requestedWorkerRuntime
        ? `runtime: ${humanizeWorkerRuntime(thread.requestedWorkerRuntime)}`
        : '',
      thread.updatedAt ? `更新: ${formatDate(thread.updatedAt)}` : '',
      thread.queueDepth > 0 ? `キュー: ${thread.queueDepth}` : '',
      thread.assigneeLabel ? `担当: ${thread.assigneeLabel}` : '',
      workerRuntimeLabel(thread)
        ? `実行状態: ${workerRuntimeLabel(thread)}`
        : '',
    ]
      .filter(Boolean)
      .join(' / ');
    this.#detailEl.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'detail-body';

    const overview = document.createElement('div');
    overview.className = 'detail-overview';
    overview.append(
      makeDetailSummaryCard(
        'いまの状態',
        workerRuntimeLabel(thread) ?? STATE_LABELS[thread.uiState],
        describeThreadState(thread) ?? threadStateLocation(thread)
      ),
      makeDetailSummaryCard(
        '次にすること',
        threadNextActionText(thread),
        thread.uiState === 'done'
          ? '必要なら下の操作で開き直せます。'
          : 'この会話を開いたまま、下の送信欄からそのまま続きや確認を送れます。'
      ),
      makeDetailSummaryCard(
        '作業の前提',
        detailContextSummary(thread, threadsById) ??
          'この件だけ見れば進められます。',
        thread.updatedAt
          ? `最終更新: ${formatDate(thread.updatedAt)}`
          : '更新時刻はまだありません。'
      )
    );
    body.appendChild(overview);

    const contextNote = describeWorkItemContext(thread, threadsById);
    if (contextNote) {
      const note = document.createElement('div');
      note.className = 'detail-note';
      note.textContent = humanizeThreadReferenceText(
        contextNote,
        threadTitlesById
      );
      body.appendChild(note);
    }

    const noteText = describeThreadState(thread);
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'detail-note';
      note.textContent = noteText;
      body.appendChild(note);
    }

    if (thread.managedVerifyCommand) {
      const note = document.createElement('div');
      note.className = 'detail-note';
      note.textContent = `verify: ${thread.managedVerifyCommand}`;
      body.appendChild(note);
    }

    const liveActivityPanel = makeLiveActivityPanel(thread, threadTitlesById);
    if (liveActivityPanel) {
      body.appendChild(liveActivityPanel);
    }

    const parentThreads = collectRelatedThreads(
      thread.derivedFromThreadIds ?? [],
      threadsById
    );
    const childThreads = collectRelatedThreads(
      thread.derivedChildThreadIds ?? [],
      threadsById
    );
    if (parentThreads.length > 0 || childThreads.length > 0) {
      const related = document.createElement('section');
      related.className = 'detail-related';

      const heading = document.createElement('div');
      heading.className = 'detail-related-heading';
      heading.textContent = '関連 work item';
      related.appendChild(heading);

      const groups: Array<{ label: string; items: ThreadView[] }> = [];
      if (parentThreads.length > 0) {
        groups.push({ label: '派生元', items: parentThreads });
      }
      if (childThreads.length > 0) {
        groups.push({ label: '派生先', items: childThreads });
      }

      for (const group of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'detail-related-group';

        const label = document.createElement('div');
        label.className = 'detail-related-label';
        if (group.label === '派生先') {
          const breakdown = summarizeChildStateBreakdown(group.items);
          label.textContent = breakdown
            ? `${group.label} (${breakdown})`
            : group.label;
        } else {
          label.textContent = group.label;
        }
        groupEl.appendChild(label);

        const list = document.createElement('div');
        list.className = 'detail-related-list';
        for (const relatedThread of group.items) {
          list.appendChild(
            makeRelatedWorkItemButton(relatedThread, threadTitlesById, () =>
              this.#app.focusThread(relatedThread.id)
            )
          );
        }
        groupEl.appendChild(list);
        related.appendChild(groupEl);
      }

      body.appendChild(related);
    }

    if (thread.seedRecoveryPending) {
      const recovery = document.createElement('section');
      recovery.className = 'detail-related';

      const heading = document.createElement('div');
      heading.className = 'detail-related-heading';
      heading.textContent = '退避して続行';
      recovery.appendChild(heading);

      const summary = document.createElement('div');
      summary.className = 'detail-note';
      summary.textContent =
        'この依頼だけ、対象 repo の seed worktree に tracked changes があるため止まっています。ここで一時退避すると同じ queue をそのまま再開できます。';
      recovery.appendChild(summary);

      const repoGroup = document.createElement('div');
      repoGroup.className = 'detail-related-group';
      const repoLabel = document.createElement('div');
      repoLabel.className = 'detail-related-label';
      repoLabel.textContent = '対象 repo';
      repoGroup.appendChild(repoLabel);
      const repoValue = document.createElement('div');
      repoValue.className = 'detail-related-item';
      repoValue.textContent =
        thread.seedRecoveryRepoLabel ||
        thread.managedRepoLabel ||
        thread.seedRecoveryRepoRoot ||
        'repo 情報を取得できませんでした。';
      repoGroup.appendChild(repoValue);
      recovery.appendChild(repoGroup);

      if (thread.seedRecoveryChangedFiles.length > 0) {
        const filesGroup = document.createElement('div');
        filesGroup.className = 'detail-related-group';
        const filesLabel = document.createElement('div');
        filesLabel.className = 'detail-related-label';
        filesLabel.textContent = 'tracked files';
        filesGroup.appendChild(filesLabel);

        const filesList = document.createElement('div');
        filesList.className = 'detail-related-list';
        for (const filePath of summarizeSeedRecoveryFiles(
          thread.seedRecoveryChangedFiles
        )) {
          const fileItem = document.createElement('div');
          fileItem.className = 'detail-related-item';
          fileItem.textContent = filePath;
          filesList.appendChild(fileItem);
        }
        filesGroup.appendChild(filesList);
        recovery.appendChild(filesGroup);
      }

      body.appendChild(recovery);
    }

    const msgArea = document.createElement('div');
    msgArea.className = 'msg-area';
    const detailMessages = messagesForDetail(thread, threadTitlesById);
    if (detailMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'detail-empty';
      empty.textContent =
        'まだやり取りはありません。下の送信欄から最初のメッセージを送れます。';
      msgArea.appendChild(empty);
    } else {
      for (const message of detailMessages) {
        msgArea.appendChild(makeBubble(message, threadTitlesById));
      }
    }
    body.appendChild(msgArea);

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    if (thread.seedRecoveryPending) {
      const preserveButton = document.createElement('button');
      preserveButton.style.width = 'auto';
      preserveButton.className = 'btn';
      preserveButton.textContent = pendingSeedRecovery
        ? '退避して続行しています…'
        : '退避して続行';
      preserveButton.disabled = pendingSeedRecovery;
      preserveButton.addEventListener('click', () => {
        void this.#app.preserveSeedRecoveryAndContinue(thread.id);
      });
      actions.appendChild(preserveButton);
    }

    const statusButton = document.createElement('button');
    statusButton.style.width = 'auto';
    if (pendingAction) {
      statusButton.className =
        thread.uiState === 'done' ? 'btn btn-ghost' : 'btn btn-secondary';
      statusButton.textContent = pendingThreadActionLabel(pendingAction);
      statusButton.disabled = true;
    } else if (thread.uiState === 'done') {
      statusButton.className = 'btn btn-ghost';
      statusButton.textContent = 'もう一度開く';
      statusButton.addEventListener('click', () => {
        void this.#app.reopenThread(thread.id);
      });
    } else {
      statusButton.className = 'btn btn-secondary';
      statusButton.textContent = 'この件は完了';
      statusButton.addEventListener('click', () => {
        void this.#app.resolveThread(thread.id);
      });
    }
    actions.appendChild(statusButton);
    body.appendChild(actions);
    this.#detailEl.appendChild(body);

    if (!sameThread) {
      this.#revealLatestMessage(msgArea);
      return;
    }

    if (preserveBottom) {
      this.#revealLatestMessage(msgArea);
      return;
    }

    this.#restoreScrollPosition(msgArea, previousScrollTop, previousAnchor);
  }

  clear(): void {
    this.#currentThreadId = null;
    this.#lastRenderedSignature = null;
    this.#detailEl.classList.add('hidden');
    this.#detailEl.innerHTML =
      '<div class="detail-empty">作業項目を開くと、ここにその会話が表示されます。</div>';
  }
}

class ManagerApp {
  allThreads: ThreadView[] = [];
  allTasks: Task[] = [];
  openThreadId: string | null = null;
  #composerTargetThreadId: string | null = null;
  #openThreadMovementNotice: string | null = null;

  #sections: Record<ManagerUiState, ThreadSectionController>;
  #taskSection: TaskSectionController;
  #buildSection: BuildSectionController;
  #detail: DetailController;
  #authToken = readStoredAuthToken();
  #liveStreamAbort: AbortController | null = null;
  #liveReconnectTimer: number | null = null;
  #liveStaleTimer: number | null = null;
  #showDone = false;
  #managerStatus: ManagerStatusPayload | null = null;
  #composerDock: HTMLElement | null = null;
  #composerResizeObserver: ResizeObserver | null = null;
  #composerExpanded = false;
  #composerAttachments = new Map<string, ManagerMessageAttachment>();
  #composerAttachmentSerial = 0;
  #composerImageDragDepth = 0;
  #composerSelectionStart: number | null = null;
  #composerSelectionEnd: number | null = null;
  #composerFeedbackEntries: ComposerFeedbackEntry[] =
    readStoredComposerFeedbackEntries();
  #composerFeedbackSerial = 0;
  #composerFeedbackExpanded = false;
  #composerFeedbackRetryTimers = new Map<string, number>();
  #composerFeedbackInFlight = new Set<string>();
  #pendingHistoryComposerTargetRestore = false;
  #lifecycleRefreshReady = false;
  #lastLifecycleRefreshAt = 0;
  #resumeRefreshPending = false;
  #resumeRefreshInFlight = false;
  #lastAppliedSnapshotAt = 0;
  #lastLiveEventAt = 0;
  #lastLiveEventKind: string | null = null;
  #liveIssue: ManagerLiveIssue | null = null;
  #diagnosticEvents: ManagerLifecycleDebugEntry[] = [];
  #pendingThreadMutations = new Map<string, PendingThreadMutation>();
  #pendingSeedRecoveryThreads = new Set<string>();
  #sortOrders = buildManagerSortOrders();

  constructor() {
    this.#sections = {
      'routing-confirmation-needed': new ThreadSectionController(
        'routing-confirmation-needed'
      ),
      'user-reply-needed': new ThreadSectionController('user-reply-needed'),
      'ai-finished-awaiting-user-confirmation': new ThreadSectionController(
        'ai-finished-awaiting-user-confirmation'
      ),
      queued: new ThreadSectionController('queued'),
      'ai-working': new ThreadSectionController('ai-working'),
      'cancelled-as-superseded': new ThreadSectionController(
        'cancelled-as-superseded'
      ),
      done: new ThreadSectionController('done'),
    };
    this.#taskSection = new TaskSectionController();
    this.#buildSection = new BuildSectionController();
    this.#buildSection.setOnRollback((hash) => void this.#rollbackBuild(hash));
    this.#buildSection.setFetcher((input, init) => this.apiFetch(input, init));
    this.#detail = new DetailController(
      document.getElementById('thread-detail') as HTMLElement,
      this
    );
  }

  init(): void {
    this.#consumeHashToken();
    this.#installDiagnosticsBridge();
    this.#composerDock = document.getElementById('global-composer-dock');
    this.#wireComposerDockReserve();
    this.#wireActions();
    this.#wireHistory();
    this.#wireAuthPanel();
    this.#wireLifecycleRefresh();
    this.#renderDoneToggle();
    this.#renderSortControls();
    this.#renderComposerExpansionState();
    this.#syncComposerDraftUi();
    this.#renderContextualComposerHints();
    this.#renderLiveConnectionState();

    if (MANAGER_AUTH_REQUIRED && !this.#authToken) {
      this.#showAuthPanel();
      return;
    }

    this.#hideAuthPanel();
    void this.#bootAfterAuth();
  }

  dispose(): void {
    this.#stopLiveStream('dispose');
    if (this.#liveStaleTimer !== null) {
      window.clearTimeout(this.#liveStaleTimer);
      this.#liveStaleTimer = null;
    }
    this.#clearComposerFeedbackRetryTimers();
    this.#composerFeedbackInFlight.clear();
    if (this.#composerResizeObserver) {
      this.#composerResizeObserver.disconnect();
      this.#composerResizeObserver = null;
    }
    delete window.__workspaceAgentHubManagerDiagnostics;
    if (window.__workspaceAgentHubManagerApp__ === this) {
      delete window.__workspaceAgentHubManagerApp__;
    }
  }

  #wireHistory(): void {
    const currentState = readManagerHistoryState();
    if (currentState?.screen === 'thread' && currentState.threadId) {
      this.openThreadId = currentState.threadId;
      this.#pendingHistoryComposerTargetRestore = true;
    } else {
      window.history.replaceState(
        inboxHistoryState(),
        '',
        window.location.pathname + window.location.search + window.location.hash
      );
    }

    window.addEventListener('popstate', () => {
      this.#applyHistoryState(readManagerHistoryState());
    });
  }

  #setHistoryState(state: ManagerHistoryState, mode: 'push' | 'replace'): void {
    const url =
      window.location.pathname + window.location.search + window.location.hash;
    if (mode === 'push') {
      window.history.pushState(state, '', url);
      return;
    }
    window.history.replaceState(state, '', url);
  }

  #applyHistoryState(state: ManagerHistoryState | null): void {
    if (state?.screen === 'thread' && state.threadId) {
      this.#showThread(state.threadId, 'none');
      return;
    }
    this.#hideThread('none');
  }

  focusComposer(): void {
    this.#setComposerExpanded(true);
    const input = document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
    input?.focus();
  }

  focusComposerForThread(threadId: string | null): void {
    this.#setComposerTarget(threadId);
    this.#renderAll();
    this.focusComposer();
  }

  focusThread(threadId: string): void {
    this.#focusThread(threadId);
  }

  #composerInput(): HTMLTextAreaElement | null {
    return document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
  }

  #setComposerDropActive(active: boolean): void {
    document
      .getElementById('composerPanel')
      ?.classList.toggle('composer-card-drop-active', active);
    this.#composerInput()?.classList.toggle(
      'composer-textarea-drop-active',
      active
    );
  }

  #resetComposerDropState(): void {
    this.#composerImageDragDepth = 0;
    this.#setComposerDropActive(false);
  }

  #imageFilesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
    if (!transfer) {
      return [];
    }

    const itemFiles = Array.from(transfer.items ?? []).flatMap((item) => {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) {
        return [];
      }
      const file = item.getAsFile();
      return file ? [file] : [];
    });
    if (itemFiles.length > 0) {
      return itemFiles;
    }
    return Array.from(transfer.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    );
  }

  #hasImageTransfer(transfer: DataTransfer | null | undefined): boolean {
    return this.#imageFilesFromTransfer(transfer).length > 0;
  }

  #referencedComposerAttachments(markdown: string): ManagerMessageAttachment[] {
    const attachmentIds = extractManagerMessageAttachmentIds(markdown);
    return attachmentIds.flatMap((attachmentId) => {
      const attachment = this.#composerAttachments.get(attachmentId);
      return attachment ? [attachment] : [];
    });
  }

  #serializedComposerContent(markdown: string): string {
    return serializeManagerMessage({
      content: markdown,
      attachments: this.#referencedComposerAttachments(markdown),
    });
  }

  #syncComposerDraftUi(): void {
    const markdown = this.#composerInput()?.value.replace(/\r\n?/g, '\n') ?? '';
    this.#renderComposerAttachmentList(markdown);
    this.#renderComposerSendAvailability(markdown);
  }

  #renderComposerSendAvailability(markdown: string): void {
    const sendButton = document.getElementById(
      'globalComposerSendButton'
    ) as HTMLButtonElement | null;
    if (!sendButton) {
      return;
    }
    sendButton.disabled = markdown.trim().length === 0;
  }

  #renderComposerAttachmentList(markdown: string): void {
    const list = document.getElementById('composerAttachmentList');
    if (!list) {
      return;
    }

    list.innerHTML = '';
    const attachments = this.#referencedComposerAttachments(markdown);
    if (attachments.length === 0) {
      list.classList.add('hidden');
      return;
    }

    list.classList.remove('hidden');
    for (const attachment of attachments) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'composer-chip';
      chip.textContent = `画像: ${attachment.name} を外す`;
      chip.addEventListener('click', () => {
        this.#removeComposerAttachment(attachment.id);
      });
      list.appendChild(chip);
    }
  }

  #removeComposerAttachment(attachmentId: string): void {
    const input = this.#composerInput();
    if (!input) {
      return;
    }
    const escapedId = attachmentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    input.value = input.value
      .replace(
        new RegExp(`!\\[[^\\]]*\\]\\(attachment://${escapedId}\\)`, 'g'),
        ''
      )
      .replace(/\n{3,}/g, '\n\n');
    this.#composerAttachments.delete(attachmentId);
    this.#syncComposerDraftUi();
    input.focus();
  }

  #insertTextAtCursor(
    input: HTMLTextAreaElement,
    text: string,
    selectionStart = input.selectionStart ?? input.value.length,
    selectionEnd = input.selectionEnd ?? selectionStart
  ): void {
    input.setRangeText(text, selectionStart, selectionEnd, 'end');
  }

  #rememberComposerSelection(): void {
    const input = this.#composerInput();
    if (!input) {
      this.#composerSelectionStart = null;
      this.#composerSelectionEnd = null;
      return;
    }
    this.#composerSelectionStart = input.selectionStart ?? input.value.length;
    this.#composerSelectionEnd =
      input.selectionEnd ?? this.#composerSelectionStart;
  }

  #imageInsertionText(
    input: HTMLTextAreaElement,
    insertions: string[],
    selectionStart: number,
    selectionEnd: number
  ): string {
    const before = input.value.slice(0, selectionStart);
    const after = input.value.slice(selectionEnd);
    const prefix =
      selectionStart === 0
        ? ''
        : before.endsWith('\n\n')
          ? ''
          : before.endsWith('\n')
            ? '\n'
            : '\n\n';
    const suffix =
      selectionEnd >= input.value.length
        ? ''
        : after.startsWith('\n\n')
          ? ''
          : after.startsWith('\n')
            ? '\n'
            : '\n\n';
    return `${prefix}${insertions.join('\n\n')}${suffix}`;
  }

  #readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const FileReaderCtor =
        window.FileReader ??
        (
          globalThis as typeof globalThis & {
            FileReader?: typeof FileReader;
          }
        ).FileReader;
      if (!FileReaderCtor) {
        reject(new Error('FileReader is not available'));
        return;
      }
      const reader = new FileReaderCtor();
      reader.addEventListener('load', () => {
        if (typeof reader.result === 'string') {
          resolvePromise(reader.result);
          return;
        }
        reject(new Error('Failed to read image as data URL'));
      });
      reader.addEventListener('error', () => {
        reject(reader.error ?? new Error('Failed to read image file'));
      });
      reader.readAsDataURL(file);
    });
  }

  async #insertComposerImages(
    files: FileList | File[],
    selectionStart?: number,
    selectionEnd?: number
  ): Promise<void> {
    const input = this.#composerInput();
    if (!input || files.length === 0) {
      return;
    }

    const insertions: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        continue;
      }
      const attachmentId = `img-${Date.now()}-${this.#composerAttachmentSerial}`;
      this.#composerAttachmentSerial += 1;
      const attachment: ManagerMessageAttachment = {
        id: attachmentId,
        name: file.name || `image-${this.#composerAttachmentSerial}.png`,
        mimeType: file.type || 'image/png',
        dataUrl: await this.#readFileAsDataUrl(file),
      };
      this.#composerAttachments.set(attachmentId, attachment);
      insertions.push(`![${attachment.name}](attachment://${attachment.id})`);
    }

    if (insertions.length === 0) {
      return;
    }

    const inputLength = input.value.length;
    const rememberedStart =
      this.#composerSelectionStart ?? input.selectionStart ?? inputLength;
    const rememberedEnd =
      this.#composerSelectionEnd ?? input.selectionEnd ?? rememberedStart;
    const rangeStart = Math.min(selectionStart ?? rememberedStart, inputLength);
    const rangeEnd = Math.min(
      Math.max(selectionEnd ?? rememberedEnd, rangeStart),
      inputLength
    );
    this.#insertTextAtCursor(
      input,
      this.#imageInsertionText(input, insertions, rangeStart, rangeEnd),
      rangeStart,
      rangeEnd
    );
    this.#rememberComposerSelection();
    this.#syncComposerDraftUi();
    input.focus();
  }

  #hideThread(historyMode: 'back' | 'replace' | 'none'): void {
    if (historyMode === 'back') {
      const state = readManagerHistoryState();
      if (state?.screen === 'thread') {
        window.history.back();
        return;
      }
    }
    if (this.#composerTargetThreadId === this.openThreadId) {
      this.#composerTargetThreadId = null;
    }
    this.openThreadId = null;
    this.#openThreadMovementNotice = null;
    this.#pendingHistoryComposerTargetRestore = false;
    this.#detail.clear();
    if (historyMode === 'replace') {
      this.#setHistoryState(inboxHistoryState(), 'replace');
    }
    this.#renderAll();
  }

  closeDetail(): void {
    this.#hideThread('back');
  }

  #showThread(
    threadId: string,
    historyMode: 'push' | 'replace' | 'none'
  ): void {
    this.openThreadId = threadId;
    this.#openThreadMovementNotice = null;
    this.#pendingHistoryComposerTargetRestore = false;
    const thread = this.allThreads.find((item) => item.id === threadId) ?? null;
    if (thread?.uiState === 'done') {
      this.#showDone = true;
      this.#setComposerTarget(null);
    } else {
      this.#setComposerTarget(threadId);
    }
    if (historyMode !== 'none') {
      this.#setHistoryState(threadHistoryState(threadId), historyMode);
    }
    this.#renderDoneToggle();
    this.#renderAll();
  }

  async resolveThread(threadId: string): Promise<void> {
    const mutation = this.#beginThreadMutation(threadId, 'resolve');
    if (!mutation) {
      return;
    }
    const response = await this.apiFetch(`/api/threads/${threadId}/resolve`, {
      method: 'PUT',
    });
    if (!response || !response.ok) {
      this.#rollbackThreadMutation(threadId, mutation);
      void this.loadAll();
      return;
    }
    this.#clearThreadMutation(threadId);
  }

  async reopenThread(threadId: string): Promise<void> {
    const mutation = this.#beginThreadMutation(threadId, 'reopen');
    if (!mutation) {
      return;
    }
    const response = await this.apiFetch(`/api/threads/${threadId}/reopen`, {
      method: 'PUT',
    });
    if (!response || !response.ok) {
      this.#rollbackThreadMutation(threadId, mutation);
      void this.loadAll();
      return;
    }
    this.#clearThreadMutation(threadId);
  }

  async preserveSeedRecoveryAndContinue(threadId: string): Promise<void> {
    if (this.#pendingSeedRecoveryThreads.has(threadId)) {
      return;
    }
    this.#pendingSeedRecoveryThreads.add(threadId);
    this.#renderAll();
    try {
      const response = await this.apiFetch(
        `/api/threads/${threadId}/preserve-and-continue`,
        {
          method: 'POST',
        }
      );
      if (!response || !response.ok) {
        return;
      }
    } finally {
      this.#pendingSeedRecoveryThreads.delete(threadId);
      this.#renderAll();
      void this.loadAll();
    }
  }

  async apiFetch(
    input: string,
    init: RequestInit = {}
  ): Promise<Response | null> {
    try {
      return await apiFetchWithToken(this.#authToken, input, init);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        this.#handleAuthFailure('アクセスコードを入力してください');
        return null;
      }
      throw error;
    }
  }

  async loadAll(): Promise<boolean> {
    const response = await this.apiFetch('/api/live');
    const contentType = response?.headers.get('content-type') ?? '';
    if (
      !response ||
      !response.ok ||
      !response.body ||
      !contentType.includes('application/x-ndjson')
    ) {
      this.#setLiveIssue('invalid-live-response');
      return false;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const payload = JSON.parse(trimmed) as ManagerLiveSnapshotPayload;
          if (payload.kind === 'snapshot') {
            this.#applyLiveSnapshot(payload);
            return true;
          }
        }
      }

      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const payload = JSON.parse(trimmed) as ManagerLiveSnapshotPayload;
        if (payload.kind === 'snapshot') {
          this.#applyLiveSnapshot(payload);
          return true;
        }
      }
      this.#setLiveIssue('invalid-live-response');
      return false;
    } finally {
      void reader.cancel().catch(() => {
        /* ignore */
      });
    }
  }

  #applySnapshot(input: { threads: ThreadView[]; tasks: Task[] }): void {
    const previousOpenThread = this.#findThread(this.openThreadId);
    this.allThreads = this.#applyPendingThreadMutations(input.threads);
    this.allTasks = input.tasks;

    if (
      this.openThreadId &&
      !this.allThreads.some((thread) => thread.id === this.openThreadId)
    ) {
      this.#hideThread('replace');
    }

    if (
      this.#composerTargetThreadId &&
      !this.allThreads.some(
        (thread) => thread.id === this.#composerTargetThreadId
      )
    ) {
      this.#composerTargetThreadId = null;
    }

    const currentOpenThread = this.#findThread(this.openThreadId);
    if (
      currentOpenThread &&
      currentOpenThread.uiState !== 'done' &&
      this.#composerTargetThreadId === null &&
      this.#pendingHistoryComposerTargetRestore
    ) {
      this.#setComposerTarget(currentOpenThread.id);
      this.#pendingHistoryComposerTargetRestore = false;
    }

    const nextOpenThread = this.#findThread(this.openThreadId);
    if (
      previousOpenThread &&
      nextOpenThread &&
      previousOpenThread.uiState !== nextOpenThread.uiState
    ) {
      this.#openThreadMovementNotice = `この作業項目は「${STATE_LABELS[previousOpenThread.uiState]}」から「${STATE_LABELS[nextOpenThread.uiState]}」に移動しました。`;
      if (nextOpenThread.uiState === 'done') {
        this.#showDone = true;
        this.#renderDoneToggle();
        if (this.#composerTargetThreadId === nextOpenThread.id) {
          this.#composerTargetThreadId = null;
        }
      }
    } else if (!nextOpenThread) {
      this.#openThreadMovementNotice = null;
    }

    this.#renderAll();
    this.#renderActivitySummary();
  }

  #applyManagerStatus(payload: ManagerStatusPayload): void {
    this.#managerStatus = payload;
    const threadTitlesById = new Map(
      this.allThreads.map((thread) => [thread.id, thread.title])
    );
    const busySummary = currentBusySummary(
      this.allThreads,
      payload,
      threadTitlesById
    );
    const dot = document.getElementById(
      'manager-status-dot'
    ) as HTMLElement | null;
    const text = document.getElementById(
      'manager-status-text'
    ) as HTMLElement | null;
    const startButton = document.getElementById(
      'manager-start-btn'
    ) as HTMLButtonElement | null;

    if (payload.running) {
      const busy = managerStatusBusy(payload);
      const problem = managerStatusProblem(payload);
      if (dot) {
        dot.style.background =
          problem === 'error'
            ? '#ef4444'
            : problem === 'paused'
              ? '#f97316'
              : busy
                ? '#f59e0b'
                : '#22c55e';
      }
      if (text) {
        text.style.color =
          problem === 'error'
            ? '#b91c1c'
            : problem === 'paused'
              ? '#9a3412'
              : busy
                ? '#92400e'
                : '#166534';
        const label =
          problem === 'error'
            ? 'AI backend で問題が起きています'
            : problem === 'paused'
              ? 'Manager Codex の利用上限で停止中です'
              : busy
                ? payload.currentThreadTitle
                  ? `AI が「${payload.currentThreadTitle}」を処理中です`
                  : 'AI が作業中です'
                : '待機中です';
        const queueTail = busySummary
          ? ` — ${busySummary}`
          : payload.detail
            ? ` — ${payload.detail}`
            : !busy && (payload.pendingCount ?? 0) > 0
              ? ` — キュー ${payload.pendingCount} 件`
              : '';
        text.textContent = `${label}${queueTail}`;
      }
      if (startButton) {
        startButton.textContent =
          problem === 'paused' ? '▶ 再開する' : '▶ 起動する';
        startButton.classList.toggle('hidden', problem !== 'paused');
      }
      this.#renderActivitySummary();
      this.#renderLiveConnectionState();
      return;
    }

    if (payload.configured) {
      if (dot) {
        dot.style.background = '#64748b';
      }
      if (text) {
        text.style.color = '#334155';
        text.textContent =
          payload.detail || 'まだ始まっていません。送ると自動で動きます。';
      }
      if (startButton) {
        startButton.textContent = '▶ 起動する';
        startButton.classList.remove('hidden');
      }
      this.#renderActivitySummary();
      this.#renderLiveConnectionState();
      return;
    }

    if (dot) {
      dot.style.background = '#ef4444';
    }
    if (text) {
      text.style.color = '#b91c1c';
      text.textContent = payload.detail || 'Manager を使えません。';
    }
    if (startButton) {
      startButton.textContent = '▶ 起動する';
      startButton.classList.add('hidden');
    }
    this.#renderActivitySummary();
    this.#renderLiveConnectionState();
  }

  #applyLiveSnapshot(snapshot: ManagerLiveSnapshotPayload): boolean {
    const nextSnapshotAt = snapshotEmittedAtValue(snapshot.emittedAt);
    if (
      nextSnapshotAt > 0 &&
      this.#lastAppliedSnapshotAt > 0 &&
      nextSnapshotAt < this.#lastAppliedSnapshotAt
    ) {
      this.#recordDiagnosticEvent(
        'live:snapshot-ignored',
        snapshot.emittedAt ?? null
      );
      return false;
    }
    if (nextSnapshotAt > 0) {
      this.#lastAppliedSnapshotAt = nextSnapshotAt;
    }
    this.#resumeRefreshPending = false;
    this.#clearLiveIssue();
    this.#applySnapshot({
      threads: snapshot.threads,
      tasks: snapshot.tasks,
    });
    this.#applyManagerStatus(snapshot.status);
    return true;
  }

  #canAccessManagerApi(): boolean {
    return !MANAGER_AUTH_REQUIRED || Boolean(this.#authToken);
  }

  #startLiveStream(reason = 'start'): void {
    this.#stopLiveStream('restart');
    if (!this.#canAccessManagerApi()) {
      this.#renderLiveConnectionState();
      return;
    }
    this.#recordDiagnosticEvent('live:start', reason);
    const controller = new AbortController();
    this.#liveStreamAbort = controller;
    this.#renderLiveConnectionState();

    void this.#consumeLiveStream(controller.signal);
  }

  #stopLiveStream(reason = 'stop'): void {
    const hadReconnectTimer = this.#liveReconnectTimer !== null;
    if (this.#liveReconnectTimer !== null) {
      window.clearTimeout(this.#liveReconnectTimer);
      this.#liveReconnectTimer = null;
    }
    const hadLiveStaleTimer = this.#liveStaleTimer !== null;
    if (this.#liveStaleTimer !== null) {
      window.clearTimeout(this.#liveStaleTimer);
      this.#liveStaleTimer = null;
    }
    const hadLiveStream = this.#liveStreamAbort !== null;
    if (this.#liveStreamAbort) {
      this.#liveStreamAbort.abort();
      this.#liveStreamAbort = null;
    }
    if (hadReconnectTimer || hadLiveStaleTimer || hadLiveStream) {
      this.#recordDiagnosticEvent('live:stop', reason);
    }
    this.#renderLiveConnectionState();
  }

  #scheduleLiveReconnect(delayMs = 1000, reason = 'reconnect'): void {
    if (
      this.#liveReconnectTimer !== null ||
      !this.#canAccessManagerApi() ||
      document.visibilityState === 'hidden' ||
      typeof window === 'undefined'
    ) {
      return;
    }
    this.#recordDiagnosticEvent('live:reconnect-scheduled', reason);
    this.#liveReconnectTimer = window.setTimeout(() => {
      this.#liveReconnectTimer = null;
      this.#renderLiveConnectionState();
      this.#startLiveStream(`reconnect:${reason}`);
    }, delayMs);
    this.#renderLiveConnectionState();
  }

  #wireLifecycleRefresh(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.#resumeRefreshPending = true;
        this.#recordDiagnosticEvent('visibility:hidden');
        this.#clearLiveIssue();
        this.#stopLiveStream('visibility-hidden');
        return;
      }
      if (document.visibilityState === 'visible') {
        this.#recordDiagnosticEvent('visibility:visible');
        this.#requestLifecycleRefresh({
          force: this.#resumeRefreshPending,
          reason: 'visibility-visible',
        });
      }
    });
    window.addEventListener('online', () => {
      this.#recordDiagnosticEvent('network:online');
      this.#clearLiveIssue();
      this.#requestLifecycleRefresh({
        force: true,
        reason: 'network-online',
      });
    });
    window.addEventListener('offline', () => {
      this.#resumeRefreshPending = true;
      this.#recordDiagnosticEvent('network:offline');
      this.#setLiveIssue('offline');
      this.#stopLiveStream('network-offline');
    });
    window.addEventListener('focus', () => {
      this.#recordDiagnosticEvent('window:focus');
      this.#requestLifecycleRefresh({
        force: this.#resumeRefreshPending,
        reason: 'window-focus',
      });
    });
    window.addEventListener('pageshow', (event) => {
      if (!(event as PageTransitionEvent).persisted) {
        return;
      }
      this.#resumeRefreshPending = true;
      this.#recordDiagnosticEvent('window:pageshow-persisted');
      this.#requestLifecycleRefresh({
        force: true,
        reason: 'pageshow-persisted',
      });
    });
  }

  #armLifecycleRefresh(): void {
    this.#lifecycleRefreshReady = true;
  }

  #requestLifecycleRefresh(input?: { force?: boolean; reason?: string }): void {
    if (
      !this.#canAccessManagerApi() ||
      !this.#lifecycleRefreshReady ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }

    const force = Boolean(input?.force);
    const reason = input?.reason ?? 'unknown';
    const now = Date.now();
    if (!force && now - this.#lastLifecycleRefreshAt < 1200) {
      this.#recordDiagnosticEvent('lifecycle:refresh-throttled', reason);
      return;
    }

    this.#lastLifecycleRefreshAt = now;
    this.#recordDiagnosticEvent(
      'lifecycle:refresh-requested',
      force ? `${reason} (forced)` : reason
    );
    void this.#refreshAfterResume(reason);
  }

  async #refreshAfterResume(reason = 'resume'): Promise<void> {
    if (!this.#canAccessManagerApi() || this.#resumeRefreshInFlight) {
      return;
    }

    this.#resumeRefreshInFlight = true;
    this.#recordDiagnosticEvent('lifecycle:refresh-start', reason);
    this.#renderLiveConnectionState();
    this.#stopLiveStream(`refresh:${reason}`);
    try {
      const dataOk = await this.loadAll();
      this.#resumeRefreshPending = !dataOk;
      this.#recordDiagnosticEvent(
        this.#resumeRefreshPending
          ? 'lifecycle:refresh-partial'
          : 'lifecycle:refresh-success',
        reason
      );
    } catch (error) {
      this.#resumeRefreshPending = true;
      this.#recordDiagnosticEvent(
        'lifecycle:refresh-error',
        error instanceof Error ? `${reason}: ${error.message}` : reason
      );
      throw error;
    } finally {
      this.#resumeRefreshInFlight = false;
      this.#renderLiveConnectionState();
      if (this.#canAccessManagerApi()) {
        this.#startLiveStream(`resume:${reason}`);
      }
    }
  }

  async #consumeLiveStream(signal: AbortSignal): Promise<void> {
    try {
      const response = await apiFetchWithToken(this.#authToken, '/api/live', {
        signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (
        !response.ok ||
        !response.body ||
        !contentType.includes('application/x-ndjson')
      ) {
        this.#setLiveIssue('invalid-live-response');
        this.#scheduleLiveReconnect(1000, 'invalid-live-response');
        return;
      }

      this.#noteLiveEvent('open');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            const payload = JSON.parse(trimmed) as
              | ManagerLiveSnapshotPayload
              | { kind?: string };
            if (payload.kind === 'snapshot') {
              this.#noteLiveEvent('snapshot');
              this.#applyLiveSnapshot(payload as ManagerLiveSnapshotPayload);
            } else if (payload.kind === 'ping') {
              this.#noteLiveEvent('ping');
            }
          } catch {
            /* ignore malformed live payloads */
          }
        }
      }
      if (!signal.aborted) {
        this.#recordDiagnosticEvent('live:stream-ended');
        this.#setLiveIssue('stream-ended');
        this.#scheduleLiveReconnect(1000, 'stream-ended');
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      if (error instanceof AuthRequiredError) {
        this.#recordDiagnosticEvent('live:auth-required');
        this.#handleAuthFailure('アクセスコードを入力してください');
        return;
      }
      this.#recordDiagnosticEvent(
        'live:error',
        error instanceof Error ? error.message : String(error)
      );
      this.#setLiveIssue(
        'stream-error',
        error instanceof Error ? error.message : String(error)
      );
      this.#scheduleLiveReconnect(1000, 'stream-error');
    } finally {
      if (this.#liveStreamAbort?.signal === signal) {
        this.#liveStreamAbort = null;
        this.#renderLiveConnectionState();
      }
    }
  }

  #noteLiveEvent(kind: string): void {
    this.#lastLiveEventAt = Date.now();
    this.#lastLiveEventKind = kind;
    this.#clearLiveIssue();
    if (kind !== 'ping') {
      this.#recordDiagnosticEvent(`live:${kind}`);
    }
    this.#armLiveStaleTimer();
    this.#renderLiveConnectionState();
  }

  #armLiveStaleTimer(): void {
    if (this.#liveStaleTimer !== null) {
      window.clearTimeout(this.#liveStaleTimer);
      this.#liveStaleTimer = null;
    }
    if (
      !this.#canAccessManagerApi() ||
      typeof window === 'undefined' ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    this.#liveStaleTimer = window.setTimeout(() => {
      this.#liveStaleTimer = null;
      if (
        !this.#canAccessManagerApi() ||
        this.#resumeRefreshInFlight ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      this.#resumeRefreshPending = true;
      this.#recordDiagnosticEvent('live:stale-timeout');
      this.#setLiveIssue('stale-timeout');
      this.#requestLifecycleRefresh({
        force: true,
        reason: 'live-stale-timeout',
      });
    }, LIVE_STREAM_STALE_TIMEOUT_MS);
  }

  #recordDiagnosticEvent(event: string, detail: string | null = null): void {
    this.#diagnosticEvents = [
      ...this.#diagnosticEvents,
      {
        at: new Date().toISOString(),
        event,
        detail,
      },
    ].slice(-MANAGER_DIAGNOSTIC_EVENT_LIMIT);
  }

  #installDiagnosticsBridge(): void {
    window.__workspaceAgentHubManagerDiagnostics = () =>
      this.#buildDiagnosticsSnapshot();
  }

  #buildDiagnosticsSnapshot(): ManagerClientDiagnostics {
    return {
      generatedAt: new Date().toISOString(),
      visibilityState: document.visibilityState,
      authTokenPresent: Boolean(this.#authToken),
      lifecycleRefreshReady: this.#lifecycleRefreshReady,
      resumeRefreshPending: this.#resumeRefreshPending,
      resumeRefreshInFlight: this.#resumeRefreshInFlight,
      liveStreamConnected: this.#liveStreamAbort !== null,
      liveReconnectScheduled: this.#liveReconnectTimer !== null,
      openThreadId: this.openThreadId,
      managerCurrentThreadId: this.#managerStatus?.currentThreadId ?? null,
      lastAppliedSnapshotAt: this.#lastAppliedSnapshotAt
        ? new Date(this.#lastAppliedSnapshotAt).toISOString()
        : null,
      lastLifecycleRefreshAt: this.#lastLifecycleRefreshAt
        ? new Date(this.#lastLifecycleRefreshAt).toISOString()
        : null,
      lastLiveEventAt: this.#lastLiveEventAt
        ? new Date(this.#lastLiveEventAt).toISOString()
        : null,
      lastLiveEventKind: this.#lastLiveEventKind,
      recentEvents: [...this.#diagnosticEvents],
    };
  }

  openDetail(threadId: string): void {
    if (this.openThreadId === threadId) {
      this.closeDetail();
      return;
    }
    this.#focusThread(threadId);
  }

  pendingThreadAction(threadId: string): ThreadMutationAction | null {
    return this.#pendingThreadMutations.get(threadId)?.action ?? null;
  }

  pendingSeedRecoveryAction(threadId: string): boolean {
    return this.#pendingSeedRecoveryThreads.has(threadId);
  }

  #findThread(threadId: string | null): ThreadView | null {
    if (!threadId) {
      return null;
    }
    return this.allThreads.find((item) => item.id === threadId) ?? null;
  }

  #applyPendingThreadMutations(threads: ThreadView[]): ThreadView[] {
    if (this.#pendingThreadMutations.size === 0) {
      return threads;
    }
    return threads.map((thread) => {
      const mutation = this.#pendingThreadMutations.get(thread.id);
      return mutation
        ? applyOptimisticThreadMutation(thread, mutation)
        : thread;
    });
  }

  #beginThreadMutation(
    threadId: string,
    action: ThreadMutationAction
  ): PendingThreadMutation | null {
    if (this.#pendingThreadMutations.has(threadId)) {
      return null;
    }
    const currentThread = this.#findThread(threadId);
    if (!currentThread) {
      return null;
    }
    const mutation: PendingThreadMutation = {
      action,
      previousThread: currentThread,
    };
    this.#pendingThreadMutations.set(threadId, mutation);
    this.#applySnapshot({
      threads: this.allThreads,
      tasks: this.allTasks,
    });
    return mutation;
  }

  #clearThreadMutation(threadId: string): void {
    if (!this.#pendingThreadMutations.delete(threadId)) {
      return;
    }
    this.#renderAll();
  }

  #rollbackThreadMutation(
    threadId: string,
    mutation: PendingThreadMutation
  ): void {
    this.#pendingThreadMutations.delete(threadId);
    this.#applySnapshot({
      threads: this.allThreads.map((thread) =>
        thread.id === threadId ? mutation.previousThread : thread
      ),
      tasks: this.allTasks,
    });
  }

  #focusThread(threadId: string): void {
    const historyMode = this.openThreadId === null ? 'push' : 'replace';
    this.#showThread(threadId, historyMode);
  }

  #setComposerTarget(threadId: string | null): void {
    const nextThread =
      threadId === null
        ? null
        : (this.allThreads.find((item) => item.id === threadId) ?? null);
    this.#composerTargetThreadId = nextThread?.id ?? null;
  }

  #toggleComposerTargetFromThreadScreen(): void {
    const openThread = this.#findThread(this.openThreadId);
    if (openThread && openThread.uiState !== 'done') {
      this.#setComposerTarget(
        this.#composerTargetThreadId === openThread.id ? null : openThread.id
      );
      this.#renderAll();
      this.focusComposer();
      return;
    }

    this.#setComposerTarget(null);
    this.#renderAll();
    this.focusComposer();
  }

  async startManager(): Promise<void> {
    const response = await this.apiFetch('/api/manager/start', {
      method: 'POST',
    });
    if (!response) {
      return;
    }
    await this.loadAll();
  }

  #composerTargetLabel(): string {
    const targetThread = this.#findThread(this.#composerTargetThreadId);
    return composerTargetPillLabel(
      targetThread,
      this.#findThread(this.openThreadId)
    );
  }

  #buildComposerSendRequest(content: string): ComposerSendRequest {
    const openThread = this.#findThread(this.openThreadId);
    const sendsToOpenThread =
      !!openThread &&
      openThread.uiState !== 'done' &&
      openThread.id === this.#composerTargetThreadId;
    if (sendsToOpenThread) {
      return {
        route: 'thread',
        threadId: openThread.id,
        content,
      };
    }
    return {
      route: 'global',
      content,
      contextThreadId: this.#composerTargetThreadId,
    };
  }

  #composerSendRequestSpec(request: ComposerSendRequest): {
    endpoint: string;
    init: RequestInit;
  } {
    return request.route === 'thread'
      ? {
          endpoint: '/api/manager/send',
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              threadId: request.threadId,
              content: request.content,
            }),
          },
        }
      : {
          endpoint: '/api/manager/global-send',
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: request.content,
              contextThreadId: request.contextThreadId,
            }),
          },
        };
  }

  #persistComposerFeedbackEntries(): void {
    writeStoredComposerFeedbackEntries(this.#composerFeedbackEntries);
  }

  #findComposerFeedbackEntry(entryId: string): ComposerFeedbackEntry | null {
    return (
      this.#composerFeedbackEntries.find((entry) => entry.id === entryId) ??
      null
    );
  }

  #clearComposerFeedbackRetryTimer(entryId: string): void {
    const timer = this.#composerFeedbackRetryTimers.get(entryId);
    if (typeof timer !== 'number') {
      return;
    }
    window.clearTimeout(timer);
    this.#composerFeedbackRetryTimers.delete(entryId);
  }

  #clearComposerFeedbackRetryTimers(): void {
    for (const timer of this.#composerFeedbackRetryTimers.values()) {
      window.clearTimeout(timer);
    }
    this.#composerFeedbackRetryTimers.clear();
  }

  #scheduleComposerFeedbackRetry(entryId: string, delayMs: number): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.#clearComposerFeedbackRetryTimer(entryId);
    const nextDelayMs = Math.max(0, delayMs);
    const timer = window.setTimeout(() => {
      this.#composerFeedbackRetryTimers.delete(entryId);
      void this.#attemptComposerFeedbackDelivery(entryId);
    }, nextDelayMs);
    this.#composerFeedbackRetryTimers.set(entryId, timer);
  }

  #resumeComposerFeedbackRetries(): void {
    if (!this.#canAccessManagerApi()) {
      return;
    }
    for (const entry of this.#composerFeedbackEntries) {
      if (
        !entry.request ||
        entry.status === 'sent' ||
        this.#composerFeedbackRetryTimers.has(entry.id) ||
        this.#composerFeedbackInFlight.has(entry.id)
      ) {
        continue;
      }
      const retryAt = entry.nextRetryAt ? Date.parse(entry.nextRetryAt) : 0;
      const delayMs =
        Number.isFinite(retryAt) && retryAt > 0
          ? Math.max(0, retryAt - Date.now())
          : 0;
      this.#scheduleComposerFeedbackRetry(entry.id, delayMs);
    }
  }

  #queueComposerFeedbackEntry(
    content: string,
    request: ComposerSendRequest
  ): string {
    const entryId = `composer-feedback-${Date.now()}-${this.#composerFeedbackSerial}`;
    this.#composerFeedbackSerial += 1;
    const entry: ComposerFeedbackEntry = {
      id: entryId,
      content,
      targetLabel: this.#composerTargetLabel(),
      status: 'sending',
      detail: '振り分けています…',
      items: [],
      request,
      attemptCount: 0,
      nextRetryAt: null,
    };
    this.#composerFeedbackEntries = [
      entry,
      ...this.#composerFeedbackEntries,
    ].slice(0, COMPOSER_FEEDBACK_MAX_ENTRIES);
    this.#persistComposerFeedbackEntries();
    this.#renderComposerFeedback();
    return entryId;
  }

  #updateComposerFeedbackEntry(
    entryId: string,
    patch: Partial<
      Pick<
        ComposerFeedbackEntry,
        | 'status'
        | 'detail'
        | 'items'
        | 'request'
        | 'attemptCount'
        | 'nextRetryAt'
      >
    >
  ): void {
    this.#composerFeedbackEntries = this.#composerFeedbackEntries.map(
      (entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)
    );
    this.#persistComposerFeedbackEntries();
    this.#renderComposerFeedback();
  }

  #removeComposerFeedbackEntry(entryId: string): void {
    this.#clearComposerFeedbackRetryTimer(entryId);
    const nextEntries = this.#composerFeedbackEntries.filter(
      (entry) => entry.id !== entryId
    );
    if (nextEntries.length === this.#composerFeedbackEntries.length) {
      return;
    }
    this.#composerFeedbackEntries = nextEntries;
    if (nextEntries.length === 0) {
      this.#composerFeedbackExpanded = false;
    }
    this.#persistComposerFeedbackEntries();
    this.#renderComposerFeedback();
  }

  #clearComposerFeedbackEntries(): void {
    if (this.#composerFeedbackEntries.length === 0) {
      return;
    }
    this.#clearComposerFeedbackRetryTimers();
    this.#composerFeedbackEntries = [];
    this.#composerFeedbackExpanded = false;
    this.#persistComposerFeedbackEntries();
    this.#renderComposerFeedback();
  }

  #toggleComposerFeedbackExpanded(): void {
    if (this.#composerFeedbackEntries.length === 0) {
      return;
    }
    this.#composerFeedbackExpanded = !this.#composerFeedbackExpanded;
    this.#renderComposerFeedback();
  }

  #handleComposerFeedbackDeliveryFailure(
    entryId: string,
    attemptCount: number
  ): void {
    const entry = this.#findComposerFeedbackEntry(entryId);
    if (!entry?.request) {
      this.#updateComposerFeedbackEntry(entryId, {
        status: 'failed',
        detail: '送信できませんでした。',
        items: [],
        attemptCount,
        nextRetryAt: null,
      });
      return;
    }
    if (!this.#canAccessManagerApi()) {
      this.#updateComposerFeedbackEntry(entryId, {
        status: 'retrying',
        detail: 'アクセスコードを入れ直すと自動再送を再開します。',
        items: [],
        attemptCount,
        nextRetryAt: null,
      });
      return;
    }

    const delayMs = composerRetryDelayMs(attemptCount);
    this.#updateComposerFeedbackEntry(entryId, {
      status: 'retrying',
      detail: composerRetryDetailText(attemptCount, delayMs),
      items: [],
      attemptCount,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
    });
    this.#scheduleComposerFeedbackRetry(entryId, delayMs);
  }

  async #attemptComposerFeedbackDelivery(entryId: string): Promise<void> {
    const entry = this.#findComposerFeedbackEntry(entryId);
    if (!entry?.request || this.#composerFeedbackInFlight.has(entryId)) {
      return;
    }

    this.#clearComposerFeedbackRetryTimer(entryId);
    const request = entry.request;
    const attemptCount = entry.attemptCount + 1;
    this.#composerFeedbackInFlight.add(entryId);
    this.#updateComposerFeedbackEntry(entryId, {
      status: attemptCount <= 1 ? 'sending' : 'retrying',
      detail:
        attemptCount <= 1
          ? '振り分けています…'
          : '送信エラーのため自動再送しています…',
      items: [],
      attemptCount,
      nextRetryAt: null,
    });

    try {
      const { endpoint, init } = this.#composerSendRequestSpec(request);
      const response = await this.apiFetch(endpoint, init);
      if (!response || !response.ok) {
        this.#handleComposerFeedbackDeliveryFailure(entryId, attemptCount);
        return;
      }

      const summary = (await response.json()) as ManagerRoutingSummary;
      await this.loadAll();
      this.#updateComposerFeedbackEntry(entryId, {
        status: 'sent',
        detail: summary.detail,
        items: summary.items,
        request: null,
        attemptCount,
        nextRetryAt: null,
      });
    } catch {
      this.#handleComposerFeedbackDeliveryFailure(entryId, attemptCount);
    } finally {
      this.#composerFeedbackInFlight.delete(entryId);
    }
  }

  async #rollbackBuild(commitHash: string): Promise<void> {
    try {
      const response = await this.apiFetch('/api/builds/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash }),
      });
      if (!response || !response.ok) {
        const data = (await response?.json().catch(() => ({}))) as {
          error?: string;
        };
        alert(`ロールバック失敗: ${data?.error ?? 'unknown error'}`);
        return;
      }
      alert(
        'ロールバック成功。サーバーが再起動されます。ページを再読み込みしてください。'
      );
      setTimeout(() => {
        location.reload();
      }, 3000);
    } catch {
      alert('ロールバックリクエストの送信に失敗しました。');
    }
  }

  async sendGlobalMessage(): Promise<void> {
    const input = this.#composerInput();
    if (!input) {
      return;
    }
    const markdown = input.value.replace(/\r\n?/g, '\n').trim();
    const content = this.#serializedComposerContent(markdown);
    if (!content) {
      if (!markdown) {
        input.focus();
      }
      return;
    }

    const request = this.#buildComposerSendRequest(content);
    const feedbackEntryId = this.#queueComposerFeedbackEntry(content, request);
    input.value = '';
    this.#composerAttachments.clear();
    this.#composerSelectionStart = 0;
    this.#composerSelectionEnd = 0;
    this.#syncComposerDraftUi();
    input.focus();
    void this.#attemptComposerFeedbackDelivery(feedbackEntryId);
  }

  #consumeHashToken(): void {
    try {
      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, '')
      );
      const hashToken = hashParams.get('accessCode');
      if (!hashToken) {
        return;
      }
      this.#authToken = hashToken;
      writeStoredAuthToken(hashToken);
      history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    } catch {
      /* ignore */
    }
  }

  async #bootAfterAuth(): Promise<void> {
    const dataOk = await this.loadAll();
    this.#armLifecycleRefresh();
    this.#resumeComposerFeedbackRetries();
    if (dataOk) {
      this.#startLiveStream();
    }
  }

  #wireComposerDockReserve(): void {
    const sync = () => this.#syncComposerDockReserve();
    sync();
    window.addEventListener('resize', sync);
    if (typeof ResizeObserver !== 'undefined' && this.#composerDock) {
      this.#composerResizeObserver = new ResizeObserver(() => {
        this.#syncComposerDockReserve();
      });
      this.#composerResizeObserver.observe(this.#composerDock);
    }
  }

  #syncComposerDockReserve(): void {
    const fallback = 116;
    const dock = this.#composerDock;
    const reserve = dock ? Math.max(dock.getBoundingClientRect().height, 0) : 0;
    const resolvedReserve = reserve > 0 ? reserve : fallback;
    document.documentElement.style.setProperty(
      '--composer-dock-reserve',
      `${Math.ceil(resolvedReserve)}px`
    );
  }

  #wireActions(): void {
    document.addEventListener('click', (event) => {
      const target = (event.target as Element | null)?.closest('[data-action]');
      if (!target) {
        return;
      }
      const action = target.getAttribute('data-action');
      switch (action) {
        case 'refresh':
          void this.loadAll();
          break;
        case 'toggle-done':
          this.#showDone = !this.#showDone;
          this.#renderDoneToggle();
          this.#renderAll();
          break;
        case 'start-manager':
          void this.startManager();
          break;
        case 'toggle-composer':
          this.#setComposerExpanded(!this.#composerExpanded);
          if (this.#composerExpanded) {
            this.focusComposer();
          }
          break;
        case 'focus-composer':
          this.focusComposer();
          break;
        case 'close-composer':
          this.#setComposerExpanded(false);
          break;
        case 'back-to-inbox':
          this.closeDetail();
          break;
        case 'unlock-auth':
          void this.#unlockAuth();
          break;
        case 'clear-auth':
          this.#clearSavedAuth();
          break;
      }
    });

    document.addEventListener('click', (event) => {
      const sortControl = (event.target as Element | null)?.closest(
        '[data-sort-control]'
      );
      if (sortControl) {
        const key = sortControl.getAttribute('data-sort-control');
        if (isManagerSortPreferenceKey(key)) {
          event.preventDefault();
          this.#toggleSortOrder(key);
        }
        return;
      }

      const header = (event.target as Element | null)?.closest(
        '[data-section-key]'
      );
      if (!header) {
        return;
      }
      const key = header.getAttribute('data-section-key');
      if (!key) {
        return;
      }
      if (key === 'tasks') {
        this.#taskSection.toggle();
        return;
      }
      if (key === 'builds') {
        this.#buildSection.toggle();
        return;
      }
      if ((STATE_ORDER as string[]).includes(key)) {
        this.#sections[key as ManagerUiState].toggle();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const header = (event.target as Element | null)?.closest(
        '[data-section-key]'
      );
      if (!header) {
        return;
      }
      event.preventDefault();
      const key = header.getAttribute('data-section-key');
      if (!key) {
        return;
      }
      if (key === 'tasks') {
        this.#taskSection.toggle();
        return;
      }
      if (key === 'builds') {
        this.#buildSection.toggle();
        return;
      }
      if ((STATE_ORDER as string[]).includes(key)) {
        this.#sections[key as ManagerUiState].toggle();
      }
    });

    const composerInput = document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
    composerInput?.addEventListener('input', () => {
      this.#rememberComposerSelection();
      this.#syncComposerDraftUi();
    });
    composerInput?.addEventListener('click', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('keyup', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('select', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('focus', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('keydown', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('mouseup', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('touchend', () => {
      this.#rememberComposerSelection();
    });
    composerInput?.addEventListener('paste', (event) => {
      this.#rememberComposerSelection();
      const files = this.#imageFilesFromTransfer(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      const selectionStart =
        this.#composerSelectionStart ??
        composerInput.selectionStart ??
        composerInput.value.length;
      const selectionEnd =
        this.#composerSelectionEnd ??
        composerInput.selectionEnd ??
        selectionStart;
      void this.#insertComposerImages(files, selectionStart, selectionEnd);
    });
    composerInput?.addEventListener('dragenter', (event) => {
      if (!this.#hasImageTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      this.#rememberComposerSelection();
      this.#composerImageDragDepth += 1;
      this.#setComposerDropActive(true);
    });
    composerInput?.addEventListener('dragover', (event) => {
      if (!this.#hasImageTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      this.#rememberComposerSelection();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      this.#setComposerDropActive(true);
    });
    composerInput?.addEventListener('dragleave', (event) => {
      if (!this.#hasImageTransfer(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      this.#composerImageDragDepth = Math.max(
        0,
        this.#composerImageDragDepth - 1
      );
      if (this.#composerImageDragDepth === 0) {
        this.#setComposerDropActive(false);
      }
    });
    composerInput?.addEventListener('drop', (event) => {
      this.#rememberComposerSelection();
      const files = this.#imageFilesFromTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      this.#resetComposerDropState();
      const selectionStart =
        this.#composerSelectionStart ??
        composerInput.selectionStart ??
        composerInput.value.length;
      const selectionEnd =
        this.#composerSelectionEnd ??
        composerInput.selectionEnd ??
        selectionStart;
      void this.#insertComposerImages(files, selectionStart, selectionEnd);
    });
    composerInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.sendGlobalMessage();
      }
    });

    const composerImagePickerButton = document.getElementById(
      'composerImagePickerButton'
    ) as HTMLButtonElement | null;
    const composerImagePickerInput = document.getElementById(
      'composerImagePickerInput'
    ) as HTMLInputElement | null;
    const openComposerImagePicker = () => {
      this.#rememberComposerSelection();
      composerImagePickerInput?.click();
    };
    composerImagePickerButton?.addEventListener('pointerdown', () => {
      this.#rememberComposerSelection();
    });
    composerImagePickerButton?.addEventListener('mousedown', () => {
      this.#rememberComposerSelection();
    });
    composerImagePickerButton?.addEventListener('touchstart', () => {
      this.#rememberComposerSelection();
    });
    composerImagePickerButton?.addEventListener('click', () => {
      openComposerImagePicker();
    });
    composerImagePickerInput?.addEventListener('change', () => {
      const files = Array.from(composerImagePickerInput.files ?? []);
      composerImagePickerInput.value = '';
      if (files.length === 0) {
        return;
      }
      const selectionStart =
        this.#composerSelectionStart ??
        composerInput?.selectionStart ??
        composerInput?.value.length ??
        0;
      const selectionEnd =
        this.#composerSelectionEnd ??
        composerInput?.selectionEnd ??
        selectionStart;
      void this.#insertComposerImages(files, selectionStart, selectionEnd);
    });

    const composerButton = document.getElementById('globalComposerSendButton');
    composerButton?.addEventListener('click', () => {
      void this.sendGlobalMessage();
    });

    const composerTargetClear = document.getElementById(
      'composerTargetClearButton'
    ) as HTMLButtonElement | null;
    composerTargetClear?.addEventListener('click', () => {
      this.#toggleComposerTargetFromThreadScreen();
    });
    const feedbackToggleButton = document.getElementById(
      'routingFeedbackToggleButton'
    ) as HTMLButtonElement | null;
    feedbackToggleButton?.addEventListener('click', () => {
      this.#toggleComposerFeedbackExpanded();
    });
    const feedbackClearButton = document.getElementById(
      'routingFeedbackClearButton'
    ) as HTMLButtonElement | null;
    feedbackClearButton?.addEventListener('click', () => {
      this.#clearComposerFeedbackEntries();
    });
    document.addEventListener('drop', () => {
      this.#resetComposerDropState();
    });
    document.addEventListener('dragend', () => {
      this.#resetComposerDropState();
    });
  }

  #setComposerExpanded(expanded: boolean): void {
    this.#composerExpanded = expanded;
    this.#renderComposerExpansionState();
    this.#syncComposerDockReserve();
  }

  #renderComposerExpansionState(): void {
    const panel = document.getElementById('composerPanel');
    const toggle = document.getElementById(
      'composerToggleButton'
    ) as HTMLButtonElement | null;
    const closeButton = document.getElementById(
      'composerCloseButton'
    ) as HTMLButtonElement | null;
    const forceExpanded = this.openThreadId !== null;
    const expanded = forceExpanded || this.#composerExpanded;
    if (panel) {
      panel.classList.toggle('hidden', !expanded);
    }
    if (toggle) {
      toggle.textContent = '送信欄を開く';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.classList.toggle('hidden', expanded);
    }
    closeButton?.classList.toggle('hidden', forceExpanded);
    this.#composerDock?.classList.toggle(
      'composer-dock-thread-mode',
      forceExpanded
    );
    this.#composerDock?.classList.toggle('composer-dock-expanded', expanded);
  }

  #wireAuthPanel(): void {
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    if (!input) {
      return;
    }
    if (this.#authToken) {
      input.value = this.#authToken;
      this.#toggleClearAuthButton(true);
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.#unlockAuth();
      }
    });
  }

  async #unlockAuth(): Promise<void> {
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    const submitButton = document.querySelector<HTMLButtonElement>(
      '[data-action="unlock-auth"]'
    );
    const token = input?.value.trim();
    if (!token) {
      this.#setAuthError('アクセスコードを入力してください');
      input?.focus();
      return;
    }

    this.#authToken = token;
    writeStoredAuthToken(token);
    this.#toggleClearAuthButton(true);
    this.#setAuthError('');
    submitButton?.setAttribute('disabled', 'true');

    const dataOk = await this.loadAll();
    this.#armLifecycleRefresh();

    submitButton?.removeAttribute('disabled');
    if (dataOk) {
      this.#hideAuthPanel();
      this.#startLiveStream();
      this.#resumeComposerFeedbackRetries();
      return;
    }

    this.#setAuthError('アクセスコードを確認してください');
  }

  #clearSavedAuth(): void {
    this.#authToken = null;
    this.#lifecycleRefreshReady = false;
    this.#lastLifecycleRefreshAt = 0;
    this.#resumeRefreshPending = false;
    this.#lastAppliedSnapshotAt = 0;
    this.#lastLiveEventAt = 0;
    this.#lastLiveEventKind = null;
    this.#clearLiveIssue();
    this.#recordDiagnosticEvent('auth:cleared');
    this.#stopLiveStream('auth-cleared');
    clearStoredAuthToken();
    this.#toggleClearAuthButton(false);
    this.#setAuthError('');
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  #handleAuthFailure(message: string): void {
    this.#authToken = null;
    this.#lifecycleRefreshReady = false;
    this.#lastLifecycleRefreshAt = 0;
    this.#resumeRefreshPending = false;
    this.#lastAppliedSnapshotAt = 0;
    this.#lastLiveEventAt = 0;
    this.#lastLiveEventKind = null;
    this.#clearLiveIssue();
    clearStoredAuthToken();
    this.#recordDiagnosticEvent('auth:failed', message);
    this.#stopLiveStream('auth-failed');
    this.#showAuthPanel(message);
  }

  #showAuthPanel(message = ''): void {
    document.getElementById('auth-panel')?.classList.remove('hidden');
    document
      .querySelectorAll<HTMLElement>('[data-auth-content]')
      .forEach((element) => {
        element.classList.add('auth-hidden');
      });
    this.#syncComposerDockReserve();
    this.#toggleClearAuthButton(Boolean(readStoredAuthToken()));
    this.#setAuthError(message);
    this.#renderLiveConnectionState();
    (
      document.getElementById('auth-token-input') as HTMLInputElement | null
    )?.focus();
  }

  #hideAuthPanel(): void {
    document.getElementById('auth-panel')?.classList.add('hidden');
    document
      .querySelectorAll<HTMLElement>('[data-auth-content]')
      .forEach((element) => {
        element.classList.remove('auth-hidden');
      });
    this.#syncComposerDockReserve();
    this.#setAuthError('');
    this.#renderLiveConnectionState();
  }

  #setAuthError(message: string): void {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
      errorEl.textContent = message;
    }
  }

  #setLiveIssue(
    kind: ManagerLiveIssueKind,
    detail: string | null = null
  ): void {
    this.#liveIssue = {
      kind,
      detail,
      at: Date.now(),
    };
    this.#renderLiveConnectionState();
  }

  #clearLiveIssue(): void {
    if (this.#liveIssue === null) {
      return;
    }
    this.#liveIssue = null;
    this.#renderLiveConnectionState();
  }

  #lastLiveReceiptLabel(): string | null {
    if (this.#lastLiveEventAt <= 0) {
      return null;
    }
    return `最後の受信 ${formatAge(new Date(this.#lastLiveEventAt).toISOString())}`;
  }

  #buildLiveConnectionState(): ManagerLiveIndicatorState {
    const lastReceipt = this.#lastLiveReceiptLabel();
    if (!this.#canAccessManagerApi()) {
      return {
        tone: 'neutral',
        label: 'リアルタイム更新は未接続です',
        detail: 'アクセスコードを入力すると、ここに接続状態が出ます。',
      };
    }

    if (document.visibilityState === 'hidden') {
      return {
        tone: 'neutral',
        label: 'リアルタイム更新は一時停止中です',
        detail: 'このタブに戻ると最新状態を取り直します。',
      };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return {
        tone: 'danger',
        label: 'リアルタイム更新が止まっています',
        detail: [
          'ブラウザがオフラインです。ネットワークが戻ると自動でつなぎ直します。',
          lastReceipt,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (this.#resumeRefreshInFlight) {
      return {
        tone: this.#liveIssue ? 'warn' : 'neutral',
        label: this.#liveIssue
          ? 'リアルタイム更新が止まっています'
          : 'リアルタイム更新を確認中です',
        detail: [
          this.#liveIssue
            ? 'いま最新状態を取り直しています。'
            : 'いま最新状態を確認しています。',
          lastReceipt,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (this.#liveReconnectTimer !== null) {
      return {
        tone: 'warn',
        label: 'リアルタイム更新が止まっています',
        detail: ['接続を戻すため自動で再接続中です。', lastReceipt]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (this.#liveIssue) {
      const issueDetail =
        this.#liveIssue.kind === 'stale-timeout'
          ? 'しばらく更新が届いていません。'
          : this.#liveIssue.kind === 'stream-ended'
            ? '接続が途中で切れました。'
            : this.#liveIssue.kind === 'stream-error'
              ? '通信エラーが起きました。'
              : this.#liveIssue.kind === 'invalid-live-response'
                ? '更新用の応答を正しく受け取れませんでした。'
                : '接続に問題があります。';
      return {
        tone: 'danger',
        label: 'リアルタイム更新が止まっています',
        detail: [issueDetail, '自動で復旧を試みます。', lastReceipt]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (this.#liveStreamAbort !== null && this.#lastLiveEventAt > 0) {
      return {
        tone: 'ok',
        label: 'リアルタイム更新 接続中',
        detail: lastReceipt ?? '最新状態を継続して受信しています。',
      };
    }

    if (this.#liveStreamAbort !== null) {
      return {
        tone: 'neutral',
        label: 'リアルタイム更新を確認中です',
        detail: 'いま接続を確立しています。',
      };
    }

    if (this.#lastAppliedSnapshotAt > 0) {
      return {
        tone: 'warn',
        label: 'リアルタイム更新を確認中です',
        detail: [
          '表示中の一覧は直前の受信結果です。接続を戻しています。',
          lastReceipt,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    return {
      tone: 'neutral',
      label: 'リアルタイム更新を確認中です',
      detail: '最初の状態を読んでいます。',
    };
  }

  #renderLiveConnectionState(): void {
    const root = document.getElementById('manager-live-status');
    const label = document.getElementById('manager-live-pill-label');
    const detail = document.getElementById('manager-live-detail');
    if (!root || !label || !detail) {
      return;
    }
    const state = this.#buildLiveConnectionState();
    root.dataset.liveTone = state.tone;
    label.textContent = state.label;
    detail.textContent = state.detail;
  }

  #toggleClearAuthButton(visible: boolean): void {
    const button = document.getElementById('auth-clear-btn');
    if (!button) {
      return;
    }
    button.classList.toggle('hidden', !visible);
  }

  #renderAll(): void {
    const grouped = new Map<ManagerUiState, ThreadView[]>(
      STATE_ORDER.map((state) => [state, []])
    );
    const threadTitlesById = buildThreadTitleMap(this.allThreads);
    const threadsById = buildThreadMap(this.allThreads);

    for (const thread of this.allThreads) {
      grouped.get(thread.uiState)?.push(thread);
    }

    this.#renderSortControls();

    const onSelect = (threadId: string) => this.openDetail(threadId);
    for (const state of STATE_ORDER) {
      const threads = sortThreadsByUpdatedAt(
        grouped.get(state) ?? [],
        this.#sortOrders[state]
      );
      this.#sections[state].update(
        threads,
        this.openThreadId,
        this.#composerTargetThreadId,
        onSelect,
        threadTitlesById,
        threadsById
      );
    }

    const doneSection = document.getElementById('sec-done');
    const doneCount = grouped.get('done')?.length ?? 0;
    doneSection?.classList.toggle('hidden', doneCount === 0 || !this.#showDone);
    this.#renderDoneToggle();

    this.#taskSection.render(this.allTasks, this.#sortOrders.tasks);
    this.#renderGettingStarted();
    this.#renderActivitySummary();
    this.#renderComposerFeedback();
    this.#renderComposerExpansionState();
    this.#renderComposerTargetBar();
    this.#renderComposerContext();
    this.#renderContextualComposerHints();
    this.#renderLiveConnectionState();
    this.#syncComposerDockReserve();

    const openThread =
      this.openThreadId === null
        ? null
        : (this.allThreads.find((thread) => thread.id === this.openThreadId) ??
          null);
    const inboxScreen = document.getElementById('manager-inbox-screen');
    const threadScreen = document.getElementById('thread-screen');
    inboxScreen?.classList.toggle('hidden', openThread !== null);
    threadScreen?.classList.toggle('hidden', openThread === null);
    this.#detail.render(
      openThread,
      this.#openThreadMovementNotice,
      threadTitlesById,
      threadsById
    );
  }

  #toggleSortOrder(key: ManagerSortPreferenceKey): void {
    this.#sortOrders[key] = toggleManagerSortOrder(this.#sortOrders[key]);
    writeStoredManagerSortOrders(this.#sortOrders);
    this.#renderAll();
  }

  #renderSortControls(): void {
    for (const key of SORTABLE_SECTION_KEYS) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-sort-control="${key}"]`
      );
      if (!button) {
        continue;
      }
      const sortOrder = this.#sortOrders[key];
      button.dataset.sortOrder = sortOrder;
      button.textContent = managerSortOrderChipLabel(sortOrder);
      const label = SORT_CONTROL_LABELS[key];
      const sortLabel = managerSortOrderLabel(sortOrder);
      button.title = `${label}: ${sortLabel}`;
      button.setAttribute(
        'aria-label',
        `${label}の表示順を切り替える。現在は${sortLabel}です。`
      );
    }
  }

  #renderContextualComposerHints(): void {
    const mediaHint = document.getElementById('composerMediaHint');
    const sendHint = document.getElementById('composerSendHint');
    const coarsePointer = isCoarsePointerDevice();
    if (mediaHint) {
      mediaHint.textContent = coarsePointer
        ? '画像はアイコンから追加できます。'
        : '画像はドラッグ&ドロップか Ctrl / Cmd + V で追加できます。';
    }
    if (sendHint) {
      sendHint.classList.toggle('hidden', coarsePointer);
    }
  }

  #renderComposerTargetBar(): void {
    const label = document.getElementById('composerLabel');
    const hint = document.getElementById('composerHint');
    const targetBar = document.getElementById('composerTargetBar');
    const pill = document.getElementById('composerTargetPill');
    const sendButton = document.getElementById(
      'globalComposerSendButton'
    ) as HTMLButtonElement | null;
    const clearButton = document.getElementById(
      'composerTargetClearButton'
    ) as HTMLButtonElement | null;
    const openThread = this.#findThread(this.openThreadId);
    const setHint = (nextText: string) => {
      if (!hint) {
        return;
      }
      const normalizedText = nextText.trim();
      hint.textContent = normalizedText;
      hint.classList.toggle('hidden', normalizedText.length === 0);
    };
    if (!pill) {
      return;
    }
    const thread = this.#findThread(this.#composerTargetThreadId);
    targetBar?.classList.remove('hidden');
    if (!thread) {
      if (label) {
        label.textContent = 'AI へ送る';
      }
      setHint(
        openThread && openThread.uiState !== 'done'
          ? 'いまは別件として送ります。必要ならこの会話へ戻せます。'
          : ''
      );
      pill.textContent = composerTargetPillLabel(null, openThread);
      if (sendButton) {
        sendButton.textContent = composerSendButtonLabel(null);
      }
      if (clearButton) {
        const nextClearLabel = composerTargetClearLabel(null, openThread);
        clearButton.textContent = nextClearLabel ?? '';
        clearButton.classList.toggle('hidden', nextClearLabel === null);
      }
      return;
    }
    if (label) {
      label.textContent = composerActionLabel(thread, openThread);
    }
    setHint(
      openThread && thread.id === openThread.id
        ? thread.uiState === 'ai-working'
          ? 'この会話へ追加指示を送ります。別件は右のボタンで切り替えます。'
          : ''
        : thread.uiState === 'ai-working'
          ? 'この会話の続きならここに入り、別件なら AI が別の作業項目へ分けます。'
          : 'この会話の続きならここに入り、別件なら AI が分けて進めます。'
    );
    pill.textContent = composerTargetPillLabel(thread, openThread);
    if (sendButton) {
      sendButton.textContent = composerSendButtonLabel(thread);
    }
    if (clearButton) {
      const nextClearLabel = composerTargetClearLabel(thread, openThread);
      clearButton.textContent = nextClearLabel ?? '';
      clearButton.classList.toggle('hidden', nextClearLabel === null);
    }
  }

  #renderGettingStarted(): void {
    const hero = document.getElementById('getting-started');
    if (!hero) {
      return;
    }
    const hasThreads = this.allThreads.length > 0;
    const hasTasks = this.allTasks.length > 0;
    hero.classList.toggle('hidden', hasThreads || hasTasks);
    const copy = document.getElementById('getting-started-copy');
    const steps = Array.from(
      document.querySelectorAll<HTMLElement>('[data-getting-started-step]')
    );
    if (copy) {
      copy.textContent =
        '上の「いま依頼を送る」か、下の固定送信欄から依頼や質問をそのまま送ると、Manager が既存の作業項目への追記、新しい作業項目への分割、確認待ちの切り分けを内部で判断して進めます。';
    }
    if (steps.length >= 3) {
      steps[0].textContent =
        '1. 上の「いま依頼を送る」か、下の送信欄からやりたいことを送る';
      steps[1].textContent =
        '2. Manager が続きの作業か、新しい作業項目か、確認待ちかを内部で整理する';
      steps[2].textContent =
        '3. 一覧で「AI の順番待ち」「AI作業中」「あなたの確認待ち」を追い、必要な作業項目だけ開いて返す';
    }
  }

  #renderActivitySummary(): void {
    const primary = document.getElementById('activity-primary');
    const detail = document.getElementById('activity-detail');
    const countsRoot = document.getElementById('activity-counts');
    const nextStepTitle = document.getElementById('activity-next-step-title');
    const nextStepCopy = document.getElementById('activity-next-step-copy');
    const nextStepButton = document.getElementById(
      'activityNextStepButton'
    ) as HTMLButtonElement | null;
    const focusLanes = document.getElementById('activity-focus-lanes');
    const activitySupport = document.getElementById('activity-support');
    if (
      !primary ||
      !detail ||
      !countsRoot ||
      !nextStepTitle ||
      !nextStepCopy ||
      !nextStepButton ||
      !focusLanes ||
      !activitySupport
    ) {
      return;
    }

    const counts = Object.fromEntries(
      STATE_ORDER.map((state) => [
        state,
        this.allThreads.filter((thread) => thread.uiState === state).length,
      ])
    ) as Record<ManagerUiState, number>;

    const busy = managerStatusBusy(this.#managerStatus);
    const problem = managerStatusProblem(this.#managerStatus);
    const running = this.#managerStatus?.running ?? false;
    const configured = this.#managerStatus?.configured ?? false;
    const currentThreadTitle = this.#managerStatus?.currentThreadTitle ?? null;
    const pendingCount = this.#managerStatus?.pendingCount ?? 0;
    const statusErrorMessage = this.#managerStatus?.errorMessage ?? null;
    const threadTitlesById = new Map(
      this.allThreads.map((thread) => [thread.id, thread.title])
    );
    const threadsById = buildThreadMap(this.allThreads);
    const busyThread = currentBusyThread(this.allThreads, this.#managerStatus);
    const busyActivity = busyThread
      ? describeLiveActivity(busyThread, threadTitlesById)
      : null;
    const priorityThreads = activityPriorityThreads(this.allThreads).slice(
      0,
      3
    );

    if (problem === 'error') {
      primary.textContent = 'AI backend で問題が起きています';
    } else if (problem === 'paused') {
      primary.textContent = 'Manager Codex の利用上限で停止中です';
    } else if (busy) {
      primary.textContent = currentThreadTitle
        ? `AI が「${currentThreadTitle}」を進めています`
        : 'AI が作業や振り分けを進めています';
    } else if (counts['routing-confirmation-needed'] > 0) {
      primary.textContent = '振り分け確認が必要な作業項目があります';
    } else if (counts['user-reply-needed'] > 0) {
      primary.textContent = 'あなたの返信待ちがあります';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      primary.textContent = 'AI から返答が来ています';
    } else if (counts['queued'] > 0) {
      primary.textContent = 'AI の順番待ちがあります';
    } else if (counts['ai-working'] > 0) {
      primary.textContent = 'AI が作業中です';
    } else if (running) {
      primary.textContent = 'いまは待機中です';
    } else if (configured) {
      primary.textContent = 'まだ始まっていません';
    } else {
      primary.textContent = 'Manager を使えません';
    }

    if (problem === 'error') {
      detail.textContent = statusErrorMessage
        ? `${statusErrorMessage}${pendingCount > 0 ? ` いまはキュー ${pendingCount} 件が止まっています。` : ''}`
        : 'AI backend のエラーで処理できていません。';
    } else if (problem === 'paused') {
      detail.textContent = statusErrorMessage
        ? `${statusErrorMessage}${pendingCount > 0 ? ` いまはキュー ${pendingCount} 件が止まっています。` : ''} 上の「再開する」で再開できます。`
        : `Manager Codex の利用上限で停止しています。${pendingCount > 0 ? ` いまはキュー ${pendingCount} 件が止まっています。` : ''} 上の「再開する」で再開できます。`;
    } else if (busy) {
      detail.textContent = busyActivity?.headline
        ? [
            `いまは ${busyActivity.actorLabel} が「${busyActivity.headline}」を進めています。`,
            busyActivity.updatedLabel ? `${busyActivity.updatedLabel}。` : '',
            pendingCount > 0
              ? `この作業項目が終わると、残り ${pendingCount} 件を順番に進めます。`
              : '返答できる状態になると対応する一覧に出ます。',
          ]
            .filter(Boolean)
            .join(' ')
        : pendingCount > 0
          ? `いまの作業項目が終わると、残り ${pendingCount} 件を順番に進めます。結果が返ると対応する一覧に出ます。`
          : 'いまの作業項目を実行中です。返答できる状態になると対応する一覧に出ます。';
    } else if (running) {
      detail.textContent =
        pendingCount > 0
          ? `いまは待機中ですが、キューに ${pendingCount} 件あります。少し待つと動きます。`
          : 'いまは待機中です。上の「いま依頼を送る」か、下の送信欄から依頼や質問を送ると、Manager が内容を整理して進めます。';
    } else if (configured) {
      detail.textContent =
        'まだ始まっていません。上の「いま依頼を送る」から送ると自動で動きます。';
    } else if (counts['routing-confirmation-needed'] > 0) {
      detail.textContent =
        '「振り分けの確認が必要です」の一覧を開けば、先に答えるべきものから確認できます。';
    } else if (counts['user-reply-needed'] > 0) {
      detail.textContent =
        '「あなたの返信が必要です」の一覧を上から順に開けば、いま返した方がいい作業項目から見られます。';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      detail.textContent =
        'AI が返答済みです。「あなたの確認待ちです」の一覧から順に開いてください。';
    } else if (counts['queued'] > 0) {
      detail.textContent =
        'いま人が返すものはありません。AI の順番待ちとしてそのまま進みます。';
    } else {
      detail.textContent =
        '送った内容は作業項目ごとに分かれて、ここで今の状況が見えるようになります。';
    }

    countsRoot.innerHTML = '';
    const chipSpecs: Array<{
      key: ManagerUiState;
      label: string;
      value: number;
    }> = [
      {
        key: 'routing-confirmation-needed',
        label: '振り分け確認',
        value: counts['routing-confirmation-needed'],
      },
      {
        key: 'user-reply-needed',
        label: '返信待ち',
        value: counts['user-reply-needed'],
      },
      {
        key: 'ai-finished-awaiting-user-confirmation',
        label: 'AIから返答',
        value: counts['ai-finished-awaiting-user-confirmation'],
      },
      {
        key: 'queued',
        label: 'AI の順番待ち',
        value: counts['queued'],
      },
      {
        key: 'ai-working',
        label: 'AI作業中',
        value: counts['ai-working'],
      },
      {
        key: 'cancelled-as-superseded',
        label: '置き換え停止',
        value: counts['cancelled-as-superseded'],
      },
      {
        key: 'done',
        label: '完了',
        value: counts['done'],
      },
    ];

    for (const spec of chipSpecs) {
      const chip = document.createElement('button');
      chip.className = 'activity-chip';
      chip.type = 'button';
      chip.textContent = `${spec.label} ${spec.value}`;
      chip.addEventListener('click', () => {
        const threads = sortThreadsByUpdatedAt(
          this.allThreads.filter((thread) => thread.uiState === spec.key),
          this.#sortOrders[spec.key]
        );
        const firstThread = threads[0] ?? null;
        if (firstThread) {
          this.#focusThread(firstThread.id);
          return;
        }
        if (spec.key === 'done') {
          this.#showDone = true;
          this.#renderDoneToggle();
          this.#renderAll();
        }
      });
      countsRoot.appendChild(chip);
    }

    nextStepButton.onclick = null;
    if (problem === 'paused') {
      nextStepTitle.textContent = 'まずは Manager を再開します';
      nextStepCopy.textContent =
        '停止中のキューは、上の「再開する」かここから戻せます。';
      nextStepButton.textContent = '再開する';
      nextStepButton.onclick = () => {
        void this.startManager();
      };
    } else if (problem === 'error') {
      nextStepTitle.textContent = 'まずは状態を読み直します';
      nextStepCopy.textContent =
        '一時的な取得失敗かどうかを確認するため、最新状態を読み直します。';
      nextStepButton.textContent = '今すぐ読み直す';
      nextStepButton.onclick = () => {
        void this.loadAll();
      };
    } else if (priorityThreads[0]) {
      nextStepTitle.textContent = `最初に見る: ${priorityThreads[0].title}`;
      nextStepCopy.textContent = threadNextActionText(priorityThreads[0]);
      nextStepButton.textContent = 'この件を開く';
      nextStepButton.onclick = () => {
        this.#focusThread(priorityThreads[0]!.id);
      };
    } else if (busyThread) {
      nextStepTitle.textContent = `進行中: ${busyThread.title}`;
      nextStepCopy.textContent =
        'いまは結果待ちです。急ぎの続きなら、この件を開いてそのまま追加指示を送れます。';
      nextStepButton.textContent = '進行中の件を開く';
      nextStepButton.onclick = () => {
        this.#focusThread(busyThread.id);
      };
    } else {
      nextStepTitle.textContent = 'まずは依頼や質問を送れます';
      nextStepCopy.textContent =
        '新しい依頼でも続きでも、上の「いま依頼を送る」か下の送信欄から送れば大丈夫です。';
      nextStepButton.textContent = '送信欄を開く';
      nextStepButton.onclick = () => {
        this.focusComposer();
      };
    }

    focusLanes.innerHTML = '';
    if (priorityThreads.length > 0) {
      for (const thread of priorityThreads) {
        focusLanes.appendChild(
          makeActivityFocusCard(thread, threadTitlesById, threadsById, () =>
            this.#focusThread(thread.id)
          )
        );
      }
      activitySupport.textContent =
        '迷ったら上から順に開けば、いま見る価値が高い件から追えます。';
      focusLanes.appendChild(activitySupport);
    } else if (busyThread) {
      activitySupport.textContent =
        'いまは AI が進めています。返すものが出ると、ここに優先順で並びます。';
      focusLanes.appendChild(activitySupport);
    } else {
      activitySupport.textContent =
        '返すべきものが出ると、ここに優先順で並びます。';
      focusLanes.appendChild(activitySupport);
    }
  }

  #renderDoneToggle(): void {
    const button = document.getElementById(
      'toggleDoneButton'
    ) as HTMLButtonElement | null;
    if (button) {
      const hasDoneThreads = this.allThreads.some(
        (thread) => thread.uiState === 'done'
      );
      button.classList.toggle('hidden', !this.#showDone && !hasDoneThreads);
      button.textContent = this.#showDone
        ? '完了した作業項目を隠す'
        : '完了した作業項目を見る';
    }
  }

  #renderComposerContext(): void {
    const context = document.getElementById('composerContext');
    if (!context) {
      return;
    }
    if (this.openThreadId !== null) {
      context.textContent = '';
      context.classList.add('hidden');
      return;
    }
    const thread = this.#findThread(this.#composerTargetThreadId);
    if (thread && thread.uiState !== 'done') {
      context.classList.remove('hidden');
      context.textContent = `この送信は「${thread.title}」の続き候補として扱います。`;
      return;
    }
    context.textContent = '';
    context.classList.add('hidden');
  }

  #renderComposerFeedback(): void {
    const lane = document.getElementById('routingFeedbackLane');
    const heading = document.getElementById('routingFeedbackHeading');
    const summary = document.getElementById('routingFeedbackSummary');
    const entryList = document.getElementById('routingFeedbackList');
    const toggleButton = document.getElementById(
      'routingFeedbackToggleButton'
    ) as HTMLButtonElement | null;
    const clearButton = document.getElementById(
      'routingFeedbackClearButton'
    ) as HTMLButtonElement | null;
    if (
      !lane ||
      !heading ||
      !summary ||
      !entryList ||
      !toggleButton ||
      !clearButton
    ) {
      return;
    }

    entryList.innerHTML = '';
    if (this.#composerFeedbackEntries.length === 0) {
      lane.classList.add('hidden');
      entryList.classList.add('hidden');
      return;
    }

    lane.classList.remove('hidden');
    heading.textContent = '送信状況';
    summary.textContent = feedbackLaneSummaryText(
      this.#composerFeedbackEntries
    );
    toggleButton.textContent = this.#composerFeedbackExpanded
      ? '閉じる'
      : '開く';
    toggleButton.setAttribute(
      'aria-expanded',
      String(this.#composerFeedbackExpanded)
    );
    clearButton.classList.remove('hidden');
    entryList.classList.toggle('hidden', !this.#composerFeedbackExpanded);
    if (!this.#composerFeedbackExpanded) {
      return;
    }

    for (const entry of this.#composerFeedbackEntries) {
      const card = document.createElement('section');
      card.className = 'composer-feedback-entry';

      const top = document.createElement('div');
      top.className = 'composer-feedback-entry-top';
      top.appendChild(makeFeedbackStateBadge(entry.status));

      const target = document.createElement('span');
      target.className = 'composer-hint';
      target.textContent = entry.targetLabel;
      top.appendChild(target);
      card.appendChild(top);

      const body = document.createElement('div');
      body.className = 'composer-feedback-entry-body';
      renderMessageMarkdown(body, entry.content);
      card.appendChild(body);

      const detail = document.createElement('div');
      detail.className = 'composer-hint';
      detail.textContent = entry.detail;
      card.appendChild(detail);

      if (entry.items.length > 0) {
        const itemList = document.createElement('div');
        itemList.className = 'composer-feedback-list';
        for (const item of entry.items) {
          const label =
            item.outcome === 'routing-confirmation'
              ? `確認: ${item.title}`
              : item.title;
          itemList.appendChild(
            makeFeedbackChip(label, () => {
              this.#focusThread(item.threadId);
            })
          );
        }
        card.appendChild(itemList);
      }

      const actions = document.createElement('div');
      actions.className = 'composer-feedback-entry-actions';
      actions.appendChild(
        makeFeedbackChip('削除', () => {
          this.#removeComposerFeedbackEntry(entry.id);
        })
      );
      card.appendChild(actions);

      entryList.appendChild(card);
    }
  }
}

export { ManagerApp };

export function bootstrapManagerApp(): ManagerApp {
  window.__workspaceAgentHubManagerApp__?.dispose();
  const app = new ManagerApp();
  window.__workspaceAgentHubManagerApp__ = app;
  app.init();
  return app;
}

bootstrapManagerApp();
