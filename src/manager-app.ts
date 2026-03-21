/// <reference lib="dom" />

declare global {
  interface Window {
    GUI_DIR: string;
    MANAGER_AUTH_REQUIRED?: boolean;
    MANAGER_AUTH_STORAGE_KEY?: string;
    MANAGER_API_BASE?: string;
  }
}

interface Msg {
  sender: 'ai' | 'user';
  content: string;
  at?: string;
}

type ManagerUiState =
  | 'routing-confirmation-needed'
  | 'user-reply-needed'
  | 'ai-finished-awaiting-user-confirmation'
  | 'queued'
  | 'ai-working'
  | 'done';

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
  queueDepth: number;
  isWorking: boolean;
}

interface Task {
  id: string;
  stage?: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface ManagerStatusPayload {
  running: boolean;
  configured: boolean;
  builtinBackend: boolean;
  detail?: string;
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

interface StyleEntry {
  bg: string;
  color: string;
  border: string;
}

const GUI_DIR = window.GUI_DIR;
const MANAGER_AUTH_REQUIRED = Boolean(window.MANAGER_AUTH_REQUIRED);
const MANAGER_AUTH_STORAGE_KEY =
  window.MANAGER_AUTH_STORAGE_KEY || `workspace-agent-hub.token:${GUI_DIR}`;
const MANAGER_API_BASE = window.MANAGER_API_BASE || './api';

const STATE_ORDER: ManagerUiState[] = [
  'routing-confirmation-needed',
  'user-reply-needed',
  'ai-finished-awaiting-user-confirmation',
  'queued',
  'ai-working',
  'done',
];

const STATE_LABELS: Record<ManagerUiState, string> = {
  'routing-confirmation-needed': '振り分け確認',
  'user-reply-needed': 'あなたの返信待ち',
  'ai-finished-awaiting-user-confirmation': 'あなたの確認待ち',
  queued: '未着手',
  'ai-working': '作業中',
  done: '完了',
};

const STATE_EMPTY_COPY: Record<ManagerUiState, string> = {
  'routing-confirmation-needed': '振り分け確認が必要な話題はありません',
  'user-reply-needed': 'あなたの返信が必要な話題はありません',
  'ai-finished-awaiting-user-confirmation':
    'あなたに確認してほしい返答はありません',
  queued: 'まだ着手していない話題はありません',
  'ai-working': 'AI が作業している話題はありません',
  done: '完了済みの話題はありません',
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
  done: {
    bg: 'rgba(31, 41, 55, 0.84)',
    color: '#d1d5db',
    border: 'rgba(107, 114, 128, 0.28)',
  },
};

class AuthRequiredError extends Error {
  constructor() {
    super('Access code required');
    this.name = 'AuthRequiredError';
  }
}

function readStoredAuthToken(): string | null {
  try {
    const token = window.localStorage.getItem(MANAGER_AUTH_STORAGE_KEY);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

function writeStoredAuthToken(token: string): void {
  try {
    window.localStorage.setItem(MANAGER_AUTH_STORAGE_KEY, token);
  } catch {
    /* ignore */
  }
}

function clearStoredAuthToken(): void {
  try {
    window.localStorage.removeItem(MANAGER_AUTH_STORAGE_KEY);
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

function makeBubble(message: Msg): HTMLDivElement {
  const bubble = document.createElement('div');
  const ai = message.sender === 'ai';
  bubble.className = `bubble ${ai ? 'bubble-ai' : 'bubble-user'}`;
  bubble.dataset.messageKey = `${message.sender}|${message.at ?? ''}|${message.content}`;

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';

  const sender = document.createElement('span');
  sender.className = `bubble-sender ${ai ? 'bubble-sender-ai' : 'bubble-sender-user'}`;
  sender.textContent = ai ? '[ai]' : '[user]';

  const timestamp = document.createElement('span');
  timestamp.className = 'bubble-ts';
  timestamp.textContent = formatDate(message.at);

  const content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = message.content;

  meta.append(sender, timestamp);
  bubble.append(meta, content);
  return bubble;
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

function describeThreadState(thread: ThreadView): string | null {
  if (thread.routingConfirmationNeeded) {
    return (
      thread.routingHint ??
      'この話題だけ、どの話として扱うかをあなたに確認したい状態です。'
    );
  }
  if (thread.uiState === 'user-reply-needed') {
    return 'AI が続きに必要な確認を待っています。返事をすると上から優先的に処理します。';
  }
  if (thread.uiState === 'ai-finished-awaiting-user-confirmation') {
    return 'AI の中では一区切りついています。内容を確認して、追加があればそのまま送り、終わりなら完了にしてください。';
  }
  if (thread.uiState === 'ai-working') {
    return 'いま AI が作業中です。完了すると上の優先度へ自動で移動します。';
  }
  if (thread.uiState === 'queued') {
    return 'この話題はまだ未着手です。AI が順番に取りかかります。';
  }
  if (thread.uiState === 'done') {
    return 'この話題は完了として閉じています。必要ならもう一度開けます。';
  }
  return null;
}

class ThreadSectionController {
  #key: ManagerUiState;
  #body: HTMLElement | null;
  #count: HTMLElement | null;
  #chevron: HTMLElement | null;
  #collapsed = false;
  #rows = new Map<string, HTMLElement>();
  #orderedIds: string[] = [];
  #lastThreads: ThreadView[] = [];
  #lastOpenThreadId: string | null = null;
  #lastSelectHandler: ((id: string) => void) | null = null;

  constructor(key: ManagerUiState) {
    this.#key = key;
    this.#body = document.getElementById(`body-${key}`);
    this.#count = document.getElementById(`count-${key}`);
    this.#chevron = document.getElementById(`chevron-${key}`);
  }

  getRow(threadId: string): HTMLElement | null {
    return this.#rows.get(threadId) ?? null;
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    if (this.#body) {
      this.#body.style.display = collapsed ? 'none' : '';
    }
    if (this.#chevron) {
      this.#chevron.textContent = collapsed ? '▼' : '▲';
    }
  }

  toggle(): void {
    this.setCollapsed(!this.#collapsed);
    if (!this.#collapsed) {
      this.update(
        this.#lastThreads,
        this.#lastOpenThreadId,
        this.#lastSelectHandler
      );
    }
  }

  update(
    threads: ThreadView[],
    openThreadId: string | null,
    onSelect: ((id: string) => void) | null
  ): void {
    this.#lastThreads = threads;
    this.#lastOpenThreadId = openThreadId;
    this.#lastSelectHandler = onSelect;

    if (this.#count) {
      this.#count.textContent = threads.length > 0 ? `(${threads.length})` : '';
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

    if (threads.length === 0) {
      for (const row of this.#rows.values()) {
        row.remove();
      }
      this.#rows.clear();
      this.#orderedIds = [];
      if (!existingEmpty) {
        const empty = document.createElement('div');
        empty.className = 'section-empty';
        empty.textContent = STATE_EMPTY_COPY[this.#key];
        this.#body.appendChild(empty);
      }
      return;
    }

    existingEmpty?.remove();

    for (const thread of threads) {
      const existing = this.#rows.get(thread.id);
      if (existing) {
        this.#patchRow(existing, thread, openThreadId);
      } else {
        this.#rows.set(
          thread.id,
          this.#buildRow(thread, openThreadId, onSelect)
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
    onSelect: ((id: string) => void) | null
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
      openThreadId === thread.id ? '詳細を閉じる' : '詳細を開く';

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.dataset.rowPreview = '';
    preview.textContent = thread.previewText || 'まだやり取りはありません';

    top.append(badge, title, age, detailToggle);
    row.append(top, preview);

    if (thread.routingHint) {
      const note = document.createElement('div');
      note.className = 'thread-note';
      note.dataset.rowNote = '';
      note.textContent = thread.routingHint;
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
    openThreadId: string | null
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
      toggle.textContent =
        openThreadId === thread.id ? '詳細を閉じる' : '詳細を開く';
    }

    const preview = row.querySelector<HTMLElement>('[data-row-preview]');
    if (preview && preview.textContent !== thread.previewText) {
      preview.textContent = thread.previewText || 'まだやり取りはありません';
    }

    let note = row.querySelector<HTMLElement>('[data-row-note]');
    if (thread.routingHint) {
      if (!note) {
        note = document.createElement('div');
        note.className = 'thread-note';
        note.dataset.rowNote = '';
        row.appendChild(note);
      }
      note.textContent = thread.routingHint;
    } else {
      note?.remove();
    }
  }
}

class TaskSectionController {
  #body = document.getElementById('body-tasks');
  #count = document.getElementById('count-tasks');
  #chevron = document.getElementById('chevron-tasks');
  #collapsed = false;

  toggle(): void {
    this.#collapsed = !this.#collapsed;
    if (this.#body) {
      this.#body.style.display = this.#collapsed ? 'none' : '';
    }
    if (this.#chevron) {
      this.#chevron.textContent = this.#collapsed ? '▼' : '▲';
    }
  }

  render(tasks: Task[]): void {
    if (this.#count) {
      this.#count.textContent = tasks.length > 0 ? `(${tasks.length})` : '';
    }
    if (!this.#body || this.#collapsed) {
      return;
    }

    this.#body.innerHTML = '';
    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'section-empty';
      empty.textContent = '進行中のタスクはありません';
      this.#body.appendChild(empty);
      return;
    }

    const sorted = [...tasks].sort((left, right) => {
      const leftAt = left.updatedAt || left.createdAt || '';
      const rightAt = right.updatedAt || right.createdAt || '';
      return new Date(rightAt).getTime() - new Date(leftAt).getTime();
    });

    for (const task of sorted) {
      const row = document.createElement('div');
      row.className = 'task-row';

      const stage = document.createElement('span');
      stage.className = 'state-badge';
      stage.textContent = task.stage || 'unknown';
      stage.style.background = 'rgba(30, 64, 175, 0.18)';
      stage.style.color = '#bfdbfe';
      stage.style.borderColor = 'rgba(96, 165, 250, 0.32)';

      const desc = document.createElement('div');
      desc.className = 'task-desc';
      desc.textContent = task.description || task.id;

      const age = document.createElement('div');
      age.className = 'task-age';
      age.textContent = formatAge(task.updatedAt || task.createdAt);

      row.append(stage, desc, age);
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

  render(thread: ThreadView | null): void {
    if (!thread) {
      this.clear();
      return;
    }

    const nextSignature = JSON.stringify({
      id: thread.id,
      title: thread.title,
      uiState: thread.uiState,
      updatedAt: thread.updatedAt ?? '',
      queueDepth: thread.queueDepth,
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
    const previousScrollTop =
      this.#currentThreadId === thread.id && previousMsgArea
        ? previousMsgArea.scrollTop
        : null;
    const previousAnchor =
      this.#currentThreadId === thread.id && previousMsgArea
        ? this.#captureScrollAnchor(previousMsgArea)
        : null;

    this.#currentThreadId = thread.id;
    this.#lastRenderedSignature = nextSignature;
    this.#detailEl.classList.remove('hidden');
    this.#detailEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'detail-header';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-ghost';
    closeBtn.style.width = 'auto';
    closeBtn.textContent = '閉じる';
    closeBtn.addEventListener('click', () => this.#app.closeDetail());

    const title = document.createElement('div');
    title.className = 'detail-title';
    title.textContent = thread.title;

    const badge = makeStateBadge(thread.uiState);

    header.append(closeBtn, title, badge);
    this.#detailEl.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.textContent = [
      thread.updatedAt ? `更新: ${formatDate(thread.updatedAt)}` : '',
      thread.queueDepth > 0 ? `キュー: ${thread.queueDepth}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    this.#detailEl.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'detail-body';

    const noteText = describeThreadState(thread);
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'detail-note';
      note.textContent = noteText;
      body.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const focusComposer = document.createElement('button');
    focusComposer.className = 'btn btn-secondary';
    focusComposer.style.width = 'auto';
    focusComposer.textContent = 'この続きを送る';
    focusComposer.addEventListener('click', () => this.#app.focusComposer());
    actions.appendChild(focusComposer);

    const statusButton = document.createElement('button');
    statusButton.style.width = 'auto';
    if (thread.uiState === 'done') {
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

    const msgArea = document.createElement('div');
    msgArea.className = 'msg-area';
    if (thread.messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'detail-empty';
      empty.textContent =
        'まだやり取りはありません。下の送信欄から最初のメッセージを送れます。';
      msgArea.appendChild(empty);
    } else {
      for (const message of thread.messages) {
        msgArea.appendChild(makeBubble(message));
      }
    }
    body.appendChild(msgArea);
    this.#detailEl.appendChild(body);

    this.#restoreScrollPosition(msgArea, previousScrollTop, previousAnchor);
  }

  clear(): void {
    this.#currentThreadId = null;
    this.#lastRenderedSignature = null;
    this.#detailEl.classList.add('hidden');
    this.#detailEl.innerHTML =
      '<div class="detail-empty">左の一覧から話題を開くと、その場で流れを追えます。</div>';
  }
}

class ManagerApp {
  allThreads: ThreadView[] = [];
  allTasks: Task[] = [];
  openThreadId: string | null = null;

  #sections: Record<ManagerUiState, ThreadSectionController>;
  #taskSection: TaskSectionController;
  #detail: DetailController;
  #authToken = readStoredAuthToken();
  #pollTimer: number | null = null;
  #showDone = false;
  #sending = false;
  #managerStatus: ManagerStatusPayload | null = null;
  #composerDock: HTMLElement | null = null;
  #composerResizeObserver: ResizeObserver | null = null;

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
      done: new ThreadSectionController('done'),
    };
    this.#taskSection = new TaskSectionController();
    this.#detail = new DetailController(
      document.getElementById('thread-detail') as HTMLElement,
      this
    );
  }

  init(): void {
    this.#consumeHashToken();
    this.#composerDock = document.getElementById('global-composer-dock');
    this.#wireComposerDockReserve();
    const dirLabel = document.getElementById('dir-label');
    if (dirLabel) {
      dirLabel.textContent = GUI_DIR;
    }
    this.#wireActions();
    this.#wireAuthPanel();
    this.#renderDoneToggle();

    if (MANAGER_AUTH_REQUIRED && !this.#authToken) {
      this.#showAuthPanel();
      return;
    }

    this.#hideAuthPanel();
    void this.#bootAfterAuth();
  }

  focusComposer(): void {
    const input = document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
    input?.focus();
  }

  closeDetail(): void {
    this.openThreadId = null;
    this.#detail.clear();
    this.#renderAll();
  }

  async resolveThread(threadId: string): Promise<void> {
    const response = await this.apiFetch(`/api/threads/${threadId}/resolve`, {
      method: 'PUT',
    });
    if (!response) {
      return;
    }
    await this.loadAll();
  }

  async reopenThread(threadId: string): Promise<void> {
    const response = await this.apiFetch(`/api/threads/${threadId}/reopen`, {
      method: 'PUT',
    });
    if (!response) {
      return;
    }
    await this.loadAll();
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
    const [threadsRes, tasksRes] = await Promise.all([
      this.apiFetch('/api/threads'),
      this.apiFetch('/api/tasks'),
    ]);

    if (!threadsRes || !tasksRes) {
      return false;
    }

    if (threadsRes.ok) {
      this.allThreads = (await threadsRes.json()) as ThreadView[];
    }
    if (tasksRes.ok) {
      this.allTasks = (await tasksRes.json()) as Task[];
    }

    if (
      this.openThreadId &&
      !this.allThreads.some((thread) => thread.id === this.openThreadId)
    ) {
      this.openThreadId = null;
    }

    this.#renderAll();
    this.#renderActivitySummary();
    return true;
  }

  async loadManagerStatus(): Promise<boolean> {
    const response = await this.apiFetch('/api/manager/status');
    if (!response || !response.ok) {
      return false;
    }

    const payload = (await response.json()) as ManagerStatusPayload;
    this.#managerStatus = payload;
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
      const busy = payload.detail?.includes('処理中') ?? false;
      if (dot) {
        dot.style.background = busy ? '#f59e0b' : '#22c55e';
      }
      if (text) {
        text.style.color = busy ? '#fde68a' : '#86efac';
        text.textContent = busy
          ? `AI が作業中です${payload.detail ? ` — ${payload.detail}` : ''}`
          : `待機中です${payload.detail ? ` — ${payload.detail}` : ''}`;
      }
      startButton?.classList.add('hidden');
      this.#renderActivitySummary();
      return true;
    }

    if (payload.configured) {
      if (dot) {
        dot.style.background = '#64748b';
      }
      if (text) {
        text.style.color = '#cbd5e1';
        text.textContent =
          payload.detail || 'まだ始まっていません。送ると自動で動きます。';
      }
      startButton?.classList.remove('hidden');
      this.#renderActivitySummary();
      return true;
    }

    if (dot) {
      dot.style.background = '#ef4444';
    }
    if (text) {
      text.style.color = '#fecaca';
      text.textContent = payload.detail || 'Manager を使えません。';
    }
    startButton?.classList.add('hidden');
    this.#renderActivitySummary();
    return true;
  }

  openDetail(threadId: string): void {
    if (this.openThreadId === threadId) {
      this.closeDetail();
      return;
    }
    this.#focusThread(threadId);
  }

  #focusThread(threadId: string): void {
    this.openThreadId = threadId;
    const thread = this.allThreads.find((item) => item.id === threadId) ?? null;
    if (thread?.uiState === 'done') {
      this.#showDone = true;
      this.#renderDoneToggle();
    }
    this.#renderAll();
    if (thread) {
      const openRow = this.#sections[thread.uiState].getRow(thread.id);
      openRow?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async startManager(): Promise<void> {
    const response = await this.apiFetch('/api/manager/start', {
      method: 'POST',
    });
    if (!response) {
      return;
    }
    await this.loadManagerStatus();
  }

  async sendGlobalMessage(): Promise<void> {
    const input = document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
    if (!input) {
      return;
    }
    const content = input.value.trim();
    if (!content || this.#sending) {
      if (!content) {
        input.focus();
      }
      return;
    }

    const statusText = document.getElementById('composerStatusText');
    const sendButton = document.getElementById(
      'globalComposerSendButton'
    ) as HTMLButtonElement | null;

    this.#sending = true;
    if (sendButton) {
      sendButton.disabled = true;
    }
    if (statusText) {
      statusText.textContent = '振り分けています…';
    }

    const response = await this.apiFetch('/api/manager/global-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        contextThreadId: this.openThreadId,
      }),
    });

    this.#sending = false;
    if (sendButton) {
      sendButton.disabled = false;
    }

    if (!response) {
      if (statusText) {
        statusText.textContent = '';
      }
      return;
    }

    const summary = (await response.json()) as ManagerRoutingSummary;
    input.value = '';
    if (statusText) {
      statusText.textContent = summary.detail;
    }
    await Promise.all([this.loadAll(), this.loadManagerStatus()]);
    if (summary.items.length > 0) {
      this.#focusThread(summary.items[0].threadId);
    }
    this.#renderComposerFeedback(summary);
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
    const [dataOk, statusOk] = await Promise.all([
      this.loadAll(),
      this.loadManagerStatus(),
    ]);
    if (dataOk || statusOk) {
      this.#startPolling();
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
    const fallback = 220;
    const dock = this.#composerDock;
    const reserve = dock ? Math.max(dock.getBoundingClientRect().height, 0) : 0;
    const resolvedReserve = reserve > 0 ? reserve : fallback;
    document.documentElement.style.setProperty(
      '--composer-dock-reserve',
      `${Math.ceil(resolvedReserve)}px`
    );
  }

  #startPolling(): void {
    if (this.#pollTimer !== null) {
      return;
    }
    this.#pollTimer = window.setInterval(() => {
      void this.loadAll();
      void this.loadManagerStatus();
    }, 5000);
  }

  #stopPolling(): void {
    if (this.#pollTimer !== null) {
      window.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
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
          void Promise.all([this.loadAll(), this.loadManagerStatus()]);
          break;
        case 'toggle-done':
          this.#showDone = !this.#showDone;
          this.#renderDoneToggle();
          this.#renderAll();
          break;
        case 'start-manager':
          void this.startManager();
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
      if ((STATE_ORDER as string[]).includes(key)) {
        this.#sections[key as ManagerUiState].toggle();
      }
    });

    const composerInput = document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
    composerInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.sendGlobalMessage();
      }
    });

    const composerButton = document.getElementById('globalComposerSendButton');
    composerButton?.addEventListener('click', () => {
      void this.sendGlobalMessage();
    });
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

    const [dataOk, statusOk] = await Promise.all([
      this.loadAll(),
      this.loadManagerStatus(),
    ]);

    submitButton?.removeAttribute('disabled');
    if (dataOk || statusOk) {
      this.#hideAuthPanel();
      this.#startPolling();
      return;
    }

    this.#setAuthError('アクセスコードを確認してください');
  }

  #clearSavedAuth(): void {
    this.#authToken = null;
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
    clearStoredAuthToken();
    this.#stopPolling();
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
  }

  #setAuthError(message: string): void {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
      errorEl.textContent = message;
    }
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

    for (const thread of this.allThreads) {
      grouped.get(thread.uiState)?.push(thread);
    }

    const onSelect = (threadId: string) => this.openDetail(threadId);
    for (const state of STATE_ORDER) {
      const threads = grouped.get(state) ?? [];
      this.#sections[state].update(threads, this.openThreadId, onSelect);
    }

    const doneSection = document.getElementById('sec-done');
    doneSection?.classList.toggle(
      'hidden',
      !this.#showDone && (grouped.get('done')?.length ?? 0) === 0
    );
    if (!this.#showDone) {
      doneSection?.classList.add('hidden');
    }

    this.#taskSection.render(this.allTasks);
    this.#renderGettingStarted();
    this.#renderActivitySummary();
    this.#renderComposerContext();

    const openThread =
      this.openThreadId === null
        ? null
        : (this.allThreads.find((thread) => thread.id === this.openThreadId) ??
          null);
    this.#detail.render(openThread);
    if (openThread) {
      const openRow = this.#sections[openThread.uiState].getRow(openThread.id);
      if (openRow && this.#detail.element.parentElement !== openRow) {
        openRow.appendChild(this.#detail.element);
      }
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
  }

  #renderActivitySummary(): void {
    const primary = document.getElementById('activity-primary');
    const detail = document.getElementById('activity-detail');
    const countsRoot = document.getElementById('activity-counts');
    if (!primary || !detail || !countsRoot) {
      return;
    }

    const counts = Object.fromEntries(
      STATE_ORDER.map((state) => [
        state,
        this.allThreads.filter((thread) => thread.uiState === state).length,
      ])
    ) as Record<ManagerUiState, number>;

    const busy = this.#managerStatus?.detail?.includes('処理中') ?? false;
    const running = this.#managerStatus?.running ?? false;
    const configured = this.#managerStatus?.configured ?? false;

    if (busy) {
      primary.textContent = 'AI が返答や振り分けを進めています';
    } else if (counts['routing-confirmation-needed'] > 0) {
      primary.textContent = '振り分け確認が必要な話題があります';
    } else if (counts['user-reply-needed'] > 0) {
      primary.textContent = 'あなたの返信待ちがあります';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      primary.textContent = 'AI から返答が来ています';
    } else if (counts['queued'] > 0) {
      primary.textContent = 'まだ着手していない話題があります';
    } else if (counts['ai-working'] > 0) {
      primary.textContent = 'AI が作業中です';
    } else if (running) {
      primary.textContent = 'いまは待機中です';
    } else if (configured) {
      primary.textContent = 'まだ始まっていません';
    } else {
      primary.textContent = 'Manager を使えません';
    }

    if (busy) {
      detail.textContent =
        '順番に処理しています。返答が来た話題は上の一覧へ自動で上がります。';
    } else if (running) {
      detail.textContent =
        'いまは待機中です。新しい内容を送れば、ここから自動で動きます。';
    } else if (configured) {
      detail.textContent =
        'まだ始まっていません。下の送信欄から投げれば自動で起動します。';
    } else if (counts['user-reply-needed'] > 0) {
      detail.textContent =
        '上から順に開けば、いま返した方がいい話題から見られます。';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      detail.textContent =
        'AI が返答済みです。確認したいものから順に開いてください。';
    } else {
      detail.textContent =
        '送った内容は topic ごとに分かれて、ここで今の状況が見えるようになります。';
    }

    countsRoot.innerHTML = '';
    const chipSpecs: Array<{ label: string; value: number }> = [
      {
        label: '振り分け確認',
        value: counts['routing-confirmation-needed'],
      },
      {
        label: '返信待ち',
        value: counts['user-reply-needed'],
      },
      {
        label: 'AIから返答',
        value: counts['ai-finished-awaiting-user-confirmation'],
      },
      {
        label: '未着手',
        value: counts['queued'],
      },
      {
        label: '作業中',
        value: counts['ai-working'],
      },
      {
        label: '完了',
        value: counts['done'],
      },
    ];

    for (const spec of chipSpecs) {
      const chip = document.createElement('span');
      chip.className = 'activity-chip';
      chip.textContent = `${spec.label} ${spec.value}`;
      countsRoot.appendChild(chip);
    }
  }

  #renderDoneToggle(): void {
    const button = document.getElementById(
      'toggleDoneButton'
    ) as HTMLButtonElement | null;
    if (button) {
      button.textContent = this.#showDone ? '完了を隠す' : '完了も見る';
    }
  }

  #renderComposerContext(): void {
    const context = document.getElementById('composerContext');
    if (!context) {
      return;
    }
    const thread =
      this.openThreadId === null
        ? null
        : (this.allThreads.find((item) => item.id === this.openThreadId) ??
          null);
    if (!thread || thread.uiState === 'done') {
      context.classList.add('hidden');
      context.textContent = '';
      return;
    }
    context.classList.remove('hidden');
    context.textContent = `いま見ている「${thread.title}」を優先して振り分けます。別の話を送りたいときは、この話題をもう一度押すと外せます。`;
  }

  #renderComposerFeedback(summary: ManagerRoutingSummary): void {
    const feedback = document.getElementById('composerFeedback');
    if (!feedback) {
      return;
    }

    feedback.innerHTML = '';
    feedback.classList.remove('hidden');

    const detail = document.createElement('div');
    detail.textContent = summary.detail;
    feedback.appendChild(detail);

    if (summary.items.length > 0) {
      const list = document.createElement('div');
      list.className = 'composer-feedback-list';
      for (const item of summary.items) {
        const label =
          item.outcome === 'routing-confirmation'
            ? `確認: ${item.title}`
            : item.title;
        list.appendChild(
          makeFeedbackChip(label, () => {
            this.#focusThread(item.threadId);
          })
        );
      }
      feedback.appendChild(list);
    }
  }
}

export { ManagerApp };

export function bootstrapManagerApp(): ManagerApp {
  const app = new ManagerApp();
  app.init();
  return app;
}

bootstrapManagerApp();
