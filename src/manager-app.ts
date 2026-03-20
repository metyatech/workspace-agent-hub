/// <reference lib="dom" />

/**
 * manager-app.ts
 *
 * Browser ES module. Loaded by manager.html via <script type="module">.
 * Implements state-driven incremental UI — keyed DOM updates, no full rebuilds.
 */

declare global {
  interface Window {
    GUI_DIR: string;
    MANAGER_AUTH_REQUIRED?: boolean;
    MANAGER_AUTH_STORAGE_KEY?: string;
    MANAGER_API_BASE?: string;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface Msg {
  sender: 'ai' | 'user';
  content: string;
  at?: string;
}

interface Thread {
  id: string;
  title: string;
  status: string;
  messages?: Msg[];
  updatedAt?: string;
}

interface Task {
  id: string;
  stage?: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface StyleEntry {
  bg: string;
  color: string;
  border: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const GUI_DIR = window.GUI_DIR;
const MANAGER_AUTH_REQUIRED = Boolean(window.MANAGER_AUTH_REQUIRED);
const MANAGER_AUTH_STORAGE_KEY =
  window.MANAGER_AUTH_STORAGE_KEY || `workspace-agent-hub.token:${GUI_DIR}`;
const MANAGER_API_BASE = window.MANAGER_API_BASE || './api';

const STATUS_STYLES: Record<string, StyleEntry> = {
  'needs-reply': { bg: '#713f12', color: '#fde68a', border: '#92400e' },
  review: { bg: '#581c87', color: '#d8b4fe', border: '#6b21a8' },
  waiting: { bg: '#164e63', color: '#67e8f9', border: '#155e75' },
  active: { bg: '#1f2937', color: '#d1d5db', border: '#374151' },
  resolved: { bg: '#111827', color: '#6b7280', border: '#1f2937' },
};

const STATUS_LABELS: Record<string, string> = {
  'needs-reply': '返答待ち',
  review: '確認待ち',
  waiting: '進行中',
  active: '進行中',
  resolved: '完了',
};

const EMPTY_SECTION_COPY: Record<string, string> = {
  'ai-replied': '新しい返事はまだありません',
  'needs-reply': 'いま返答が必要な話題はありません',
  review: '確認待ちの話題はありません',
  waiting: '進行中の話題はありません',
  idle: '止まっている話題はありません',
  tasks: '進行中のタスクはありません',
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
    /* ignore localStorage failures */
  }
}

function clearStoredAuthToken(): void {
  try {
    window.localStorage.removeItem(MANAGER_AUTH_STORAGE_KEY);
  } catch {
    /* ignore localStorage failures */
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
  const res = await fetch(requestUrl, { ...init, headers });
  if (res.status === 401) {
    throw new AuthRequiredError();
  }
  return res;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function lastMsgSender(thread: Thread): 'ai' | 'user' | null {
  if (!thread.messages || thread.messages.length === 0) return null;
  return thread.messages[thread.messages.length - 1].sender;
}

function groupThreads(threads: Thread[]): Record<string, Thread[]> {
  const groups: Record<string, Thread[]> = {
    'ai-replied': [],
    'needs-reply': [],
    review: [],
    waiting: [],
    idle: [],
  };
  for (const t of threads) {
    if (t.status === 'resolved') continue;
    if (t.status === 'review') {
      groups['review'].push(t);
    } else if (t.status === 'needs-reply') {
      groups['needs-reply'].push(t);
    } else if (t.status === 'waiting') {
      groups['waiting'].push(t);
    } else if (t.status === 'active' && lastMsgSender(t) === 'ai') {
      groups['ai-replied'].push(t);
    } else {
      groups['idle'].push(t);
    }
  }
  return groups;
}

function shouldScrollToBottom({
  isFirstRender,
  hasNewMessages,
  wasNearBottom,
}: {
  isFirstRender: boolean;
  hasNewMessages: boolean;
  wasNearBottom: boolean;
}): boolean {
  return isFirstRender || (hasNewMessages && wasNearBottom);
}

function formatAge(iso: string | undefined): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth > 0) return `${diffMonth}mo`;
  if (diffWeek > 0) return `${diffWeek}w`;
  if (diffDay > 0) return `${diffDay}d`;
  if (diffHour > 0) return `${diffHour}h`;
  if (diffMin > 0) return `${diffMin}m`;
  return `${diffSec}s`;
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

function makeStatusBadge(status: string): HTMLSpanElement {
  const s = STATUS_STYLES[status] || STATUS_STYLES['active'];
  const span = document.createElement('span');
  span.className = 'status-badge';
  span.setAttribute('data-detail-badge', '');
  span.textContent = STATUS_LABELS[status] || status;
  span.style.cssText = `background:${s.bg};color:${s.color};border:1px solid ${s.border};`;
  return span;
}

function makeBubble(msg: Msg): HTMLDivElement {
  const isAi = msg.sender === 'ai';
  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (isAi ? 'bubble-ai' : 'bubble-user');

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';

  const senderBadge = document.createElement('span');
  senderBadge.className =
    'bubble-sender ' + (isAi ? 'bubble-sender-ai' : 'bubble-sender-user');
  senderBadge.textContent = isAi ? '[ai]' : '[user]';

  const ts = document.createElement('span');
  ts.className = 'bubble-ts';
  ts.textContent = formatDate(msg.at);

  meta.appendChild(senderBadge);
  meta.appendChild(ts);

  const content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = msg.content;

  bubble.appendChild(meta);
  bubble.appendChild(content);
  return bubble;
}

// ── SectionController ──────────────────────────────────────────────────────

class SectionController {
  #key: string;
  #bodyEl: HTMLElement | null;
  #countEl: HTMLElement | null;
  #chevronEl: HTMLElement | null;
  #collapsed = false;
  // Map from thread.id → row element
  #rows = new Map<string, HTMLElement>();
  // Ordered list of IDs currently in DOM
  #orderedIds: string[] = [];
  // Last known data
  #lastThreads: Thread[] = [];
  #lastOpenThreadId: string | null = null;
  #lastOnSelect: ((id: string) => void) | null = null;

  constructor(key: string) {
    this.#key = key;
    this.#bodyEl = document.getElementById(`body-${key}`);
    this.#countEl = document.getElementById(`count-${key}`);
    this.#chevronEl = document.getElementById(`chevron-${key}`);
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    if (this.#bodyEl) {
      this.#bodyEl.style.display = collapsed ? 'none' : '';
    }
    if (this.#chevronEl) {
      this.#chevronEl.textContent = collapsed ? '▼' : '▲';
    }
  }

  toggle(): void {
    this.setCollapsed(!this.#collapsed);
    if (!this.#collapsed) {
      // Expanding — reconcile immediately with last known data
      this.update(
        this.#lastThreads,
        this.#lastOpenThreadId,
        this.#lastOnSelect
      );
    }
  }

  update(
    threads: Thread[],
    openThreadId: string | null,
    onSelect: ((id: string) => void) | null
  ): void {
    this.#lastThreads = threads;
    this.#lastOpenThreadId = openThreadId;
    this.#lastOnSelect = onSelect;

    // Always update count badge
    if (this.#countEl) {
      this.#countEl.textContent =
        threads.length > 0 ? `(${threads.length})` : '';
    }

    if (this.#collapsed || !this.#bodyEl) return;

    // Sort threads by updatedAt desc
    const sorted = [...threads].sort(
      (a, b) =>
        new Date(b.updatedAt ?? '').getTime() -
        new Date(a.updatedAt ?? '').getTime()
    );
    const nextIds = sorted.map((t) => t.id);

    // Build a fast lookup for thread data
    const threadById = new Map(sorted.map((t) => [t.id, t]));

    // Remove rows no longer present
    for (const id of this.#orderedIds) {
      if (!threadById.has(id)) {
        const row = this.#rows.get(id);
        if (row && row.parentNode) row.parentNode.removeChild(row);
        this.#rows.delete(id);
      }
    }

    // Remove empty placeholder if threads exist
    const existingEmpty = this.#bodyEl.querySelector('.section-empty');

    if (threads.length === 0) {
      // Clear all rows and show empty state
      for (const [, row] of this.#rows) {
        if (row.parentNode) row.parentNode.removeChild(row);
      }
      this.#rows.clear();
      this.#orderedIds = [];
      if (!existingEmpty) {
        const empty = document.createElement('p');
        empty.className = 'section-empty';
        empty.textContent = EMPTY_SECTION_COPY[this.#key] || 'まだありません';
        this.#bodyEl.appendChild(empty);
      }
      if (this.#countEl) this.#countEl.textContent = '';
      return;
    }

    // Remove empty placeholder when threads are present
    if (existingEmpty) existingEmpty.remove();

    // Add new rows and patch existing rows
    for (const thread of sorted) {
      const existing = this.#rows.get(thread.id);
      if (existing) {
        this.#patchRow(existing, thread, openThreadId);
      } else {
        const row = this.#buildRow(thread, openThreadId, onSelect);
        this.#rows.set(thread.id, row);
      }
    }

    // Ensure correct DOM order via insertBefore
    for (let i = 0; i < nextIds.length; i++) {
      const row = this.#rows.get(nextIds[i]);
      if (!row) continue;
      const currentAtIndex = this.#bodyEl.children[i];
      if (currentAtIndex !== row) {
        this.#bodyEl.insertBefore(row, currentAtIndex || null);
      }
    }

    this.#orderedIds = nextIds;
  }

  #buildRow(
    thread: Thread,
    openThreadId: string | null,
    onSelect: ((id: string) => void) | null
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className =
      'thread-row' + (openThreadId === thread.id ? ' selected' : '');
    row.dataset.threadId = thread.id;

    const top = document.createElement('div');
    top.className = 'thread-row-top';

    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.rowBadge = '';
    this.#applyBadgeStyle(badge, thread.status);

    const title = document.createElement('span');
    title.className = 'thread-title';
    title.dataset.rowTitle = '';
    title.textContent = thread.title;

    const age = document.createElement('span');
    age.className = 'thread-age';
    age.dataset.rowAge = '';
    age.textContent = formatAge(thread.updatedAt);

    top.appendChild(badge);
    top.appendChild(title);
    top.appendChild(age);
    row.appendChild(top);

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.dataset.rowPreview = '';
    const lastMsg =
      thread.messages && thread.messages.length > 0
        ? thread.messages[thread.messages.length - 1]
        : null;
    if (lastMsg) {
      const senderLabel = lastMsg.sender === 'ai' ? '[ai]' : '[user]';
      preview.textContent = `${senderLabel} ${lastMsg.content.replace(/\n/g, ' ').slice(0, 90)}`;
    }
    row.appendChild(preview);

    row.addEventListener('click', () => {
      if (onSelect) onSelect(thread.id);
    });

    return row;
  }

  #patchRow(
    row: HTMLElement,
    thread: Thread,
    openThreadId: string | null
  ): void {
    // Update selected state
    if (openThreadId === thread.id) {
      row.classList.add('selected');
    } else {
      row.classList.remove('selected');
    }

    const badge = row.querySelector<HTMLElement>('[data-row-badge]');
    if (badge) this.#applyBadgeStyle(badge, thread.status);

    const title = row.querySelector('[data-row-title]');
    if (title && title.textContent !== thread.title) {
      title.textContent = thread.title;
    }

    const age = row.querySelector('[data-row-age]');
    if (age) age.textContent = formatAge(thread.updatedAt);

    const preview = row.querySelector('[data-row-preview]');
    if (preview) {
      const lastMsg =
        thread.messages && thread.messages.length > 0
          ? thread.messages[thread.messages.length - 1]
          : null;
      const newPreview = lastMsg
        ? `${lastMsg.sender === 'ai' ? '[ai]' : '[user]'} ${lastMsg.content.replace(/\n/g, ' ').slice(0, 90)}`
        : '';
      if (preview.textContent !== newPreview) {
        preview.textContent = newPreview;
      }
    }
  }

  #applyBadgeStyle(el: HTMLElement, status: string): void {
    const s = STATUS_STYLES[status] || STATUS_STYLES['active'];
    el.textContent = STATUS_LABELS[status] || status;
    el.style.cssText = `background:${s.bg};color:${s.color};border:1px solid ${s.border};`;
  }
}

// ── TaskSectionController ──────────────────────────────────────────────────

class TaskSectionController {
  #bodyEl: HTMLElement | null;
  #countEl: HTMLElement | null;
  #chevronEl: HTMLElement | null;
  #collapsed = false;
  #rows = new Map<string, HTMLElement>();
  #orderedIds: string[] = [];
  #lastTasks: Task[] = [];

  constructor() {
    this.#bodyEl = document.getElementById('body-tasks');
    this.#countEl = document.getElementById('count-tasks');
    this.#chevronEl = document.getElementById('chevron-tasks');
  }

  setCollapsed(collapsed: boolean): void {
    this.#collapsed = collapsed;
    if (this.#bodyEl) {
      this.#bodyEl.style.display = collapsed ? 'none' : '';
    }
    if (this.#chevronEl) {
      this.#chevronEl.textContent = collapsed ? '▼' : '▲';
    }
  }

  toggle(): void {
    this.setCollapsed(!this.#collapsed);
    if (!this.#collapsed) {
      this.update(this.#lastTasks);
    }
  }

  update(tasks: Task[]): void {
    this.#lastTasks = tasks;

    if (this.#countEl) {
      this.#countEl.textContent = tasks.length > 0 ? `(${tasks.length})` : '';
    }

    if (this.#collapsed || !this.#bodyEl) return;

    const sorted = [...tasks].sort((a, b) => {
      const ta = a.updatedAt || a.createdAt || '';
      const tb = b.updatedAt || b.createdAt || '';
      return new Date(tb).getTime() - new Date(ta).getTime();
    });
    const nextIds = sorted.map((t) => t.id);
    const taskById = new Map(sorted.map((t) => [t.id, t]));

    // Remove gone rows
    for (const id of this.#orderedIds) {
      if (!taskById.has(id)) {
        const row = this.#rows.get(id);
        if (row && row.parentNode) row.parentNode.removeChild(row);
        this.#rows.delete(id);
      }
    }

    const existingEmpty = this.#bodyEl.querySelector('.section-empty');

    if (tasks.length === 0) {
      for (const [, row] of this.#rows) {
        if (row.parentNode) row.parentNode.removeChild(row);
      }
      this.#rows.clear();
      this.#orderedIds = [];
      if (!existingEmpty) {
        const empty = document.createElement('p');
        empty.className = 'section-empty';
        empty.textContent = EMPTY_SECTION_COPY['tasks'];
        this.#bodyEl.appendChild(empty);
      }
      if (this.#countEl) this.#countEl.textContent = '';
      return;
    }

    if (existingEmpty) existingEmpty.remove();

    for (const task of sorted) {
      const existing = this.#rows.get(task.id);
      if (existing) {
        this.#patchRow(existing, task);
      } else {
        const row = this.#buildRow(task);
        this.#rows.set(task.id, row);
      }
    }

    for (let i = 0; i < nextIds.length; i++) {
      const row = this.#rows.get(nextIds[i]);
      if (!row) continue;
      const currentAtIndex = this.#bodyEl.children[i];
      if (currentAtIndex !== row) {
        this.#bodyEl.insertBefore(row, currentAtIndex || null);
      }
    }

    this.#orderedIds = nextIds;
  }

  #buildRow(task: Task): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.dataset.taskId = task.id;

    const stageBadge = document.createElement('span');
    stageBadge.className = 'status-badge';
    stageBadge.dataset.taskStage = '';
    stageBadge.textContent = task.stage || 'unknown';
    stageBadge.style.cssText =
      'background:#0f3460;color:#93c5fd;border:1px solid #1e40af;';

    const desc = document.createElement('span');
    desc.className = 'task-desc';
    desc.dataset.taskDesc = '';
    desc.textContent = task.description || task.id;

    const age = document.createElement('span');
    age.className = 'task-age';
    age.dataset.taskAge = '';
    age.textContent = formatAge(task.updatedAt || task.createdAt);

    row.appendChild(stageBadge);
    row.appendChild(desc);
    row.appendChild(age);
    return row;
  }

  #patchRow(row: HTMLElement, task: Task): void {
    const stageBadge = row.querySelector('[data-task-stage]');
    if (stageBadge) {
      const newStage = task.stage || 'unknown';
      if (stageBadge.textContent !== newStage)
        stageBadge.textContent = newStage;
    }
    const desc = row.querySelector('[data-task-desc]');
    if (desc) {
      const newDesc = task.description || task.id;
      if (desc.textContent !== newDesc) desc.textContent = newDesc;
    }
    const age = row.querySelector('[data-task-age]');
    if (age) age.textContent = formatAge(task.updatedAt || task.createdAt);
  }
}

// ── ReplyForm ──────────────────────────────────────────────────────────────

class ReplyForm {
  el!: HTMLElement;
  #thread: Thread;
  #app: ManagerApp;
  #msgInput!: HTMLTextAreaElement;
  #sendBtn!: HTMLButtonElement;
  #needsReplyBtn!: HTMLButtonElement;
  #reviewBtn!: HTMLButtonElement;
  #managerBtn!: HTMLButtonElement;
  #pendingNote!: HTMLElement;
  #doSend!: () => Promise<void>;
  #doSendWithStatus!: (status: string) => Promise<void>;
  #doSendToManager!: () => Promise<void>;

  constructor(thread: Thread, app: ManagerApp) {
    this.#thread = thread;
    this.#app = app;

    const formArea = document.createElement('div');
    formArea.className = 'reply-form';
    formArea.setAttribute('data-reply-form', '');

    const msgInput = document.createElement('textarea');
    msgInput.placeholder = 'メッセージを入力...';
    msgInput.rows = 3;
    msgInput.className = 'reply-textarea';
    msgInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.#doSendToManager();
      }
    });
    this.#msgInput = msgInput;

    const actions = document.createElement('div');
    actions.className = 'reply-actions';

    const managerBtn = document.createElement('button');
    managerBtn.textContent = '🤖 マネージャーに送る';
    managerBtn.className = 'btn btn-primary';
    managerBtn.setAttribute('data-manager-btn', '');
    managerBtn.title =
      'メッセージをスレッドに追加し、マネージャーAIにも送信します（Ctrl+Enter）';
    managerBtn.addEventListener('click', () => void this.#doSendToManager());
    this.#managerBtn = managerBtn;

    const needsReplyBtn = document.createElement('button');
    needsReplyBtn.textContent = '返答待ちにする';
    needsReplyBtn.className = 'btn btn-needs-reply';
    needsReplyBtn.title =
      'メッセージを送り、ステータスを「needs-reply」に変更する';
    needsReplyBtn.addEventListener(
      'click',
      () => void this.#doSendWithStatus('needs-reply')
    );
    this.#needsReplyBtn = needsReplyBtn;

    const reviewBtn = document.createElement('button');
    reviewBtn.textContent = '確認依頼にする';
    reviewBtn.className = 'btn btn-review';
    reviewBtn.title = 'メッセージを送り、ステータスを「review」に変更する';
    reviewBtn.addEventListener(
      'click',
      () => void this.#doSendWithStatus('review')
    );
    this.#reviewBtn = reviewBtn;

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'メモを追加';
    sendBtn.className = 'btn btn-ghost';
    sendBtn.title = 'メッセージをスレッドに追加します（AIには送信しません）';
    sendBtn.addEventListener('click', () => void this.#doSend());
    this.#sendBtn = sendBtn;

    const hintSpan = document.createElement('span');
    hintSpan.className = 'reply-hint';
    hintSpan.textContent = 'Ctrl+Enter でマネージャーに送る';

    const pendingNote = document.createElement('span');
    pendingNote.setAttribute('data-pending-note', '');
    pendingNote.style.cssText = 'font-size:0.68rem;color:#67e8f9;';
    pendingNote.classList.add('hidden');
    pendingNote.textContent = '⏳ マネージャーの返信待ち';
    this.#pendingNote = pendingNote;

    // Advanced toggle and panel
    const advToggle = document.createElement('button');
    advToggle.className = 'advanced-toggle';
    advToggle.textContent = '詳細 ▾';
    advToggle.title = 'AI送信者オプション';

    const advPanel = document.createElement('div');
    advPanel.className = 'advanced-panel hidden';

    // Sender selection
    let selectedSender = 'user';
    const senderRow = document.createElement('div');
    senderRow.className = 'advanced-row';
    const senderLabel = document.createElement('span');
    senderLabel.className = 'adv-label';
    senderLabel.textContent = '送信者:';
    const userBtn = document.createElement('button');
    userBtn.textContent = 'user';
    userBtn.className = 'opt-btn opt-user';
    const aiBtn = document.createElement('button');
    aiBtn.textContent = 'ai';
    aiBtn.className = 'opt-btn opt-inactive';

    const updateSenderBtns = () => {
      userBtn.className =
        'opt-btn ' + (selectedSender === 'user' ? 'opt-user' : 'opt-inactive');
      aiBtn.className =
        'opt-btn ' + (selectedSender === 'ai' ? 'opt-ai' : 'opt-inactive');
    };
    userBtn.addEventListener('click', () => {
      selectedSender = 'user';
      updateSenderBtns();
    });
    aiBtn.addEventListener('click', () => {
      selectedSender = 'ai';
      updateSenderBtns();
    });

    senderRow.appendChild(senderLabel);
    senderRow.appendChild(userBtn);
    senderRow.appendChild(aiBtn);
    advPanel.appendChild(senderRow);

    // Status override selection
    let selectedStatus = '';
    const statusRow = document.createElement('div');
    statusRow.className = 'advanced-row';
    const statusLabel = document.createElement('span');
    statusLabel.className = 'adv-label';
    statusLabel.textContent = 'ステータス変更:';
    const statusOptions = [
      { value: '', label: '変更なし' },
      { value: 'needs-reply', label: '返答待ちにする' },
      { value: 'review', label: '確認待ちにする' },
      { value: 'waiting', label: '進行中にする' },
      { value: 'active', label: '話題として開いておく' },
    ];
    const statusBtns = statusOptions.map((opt) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.dataset.value = opt.value;
      btn.className =
        'opt-btn ' + (opt.value === '' ? 'opt-status' : 'opt-inactive');
      btn.addEventListener('click', () => {
        selectedStatus = opt.value;
        updateStatusBtns();
      });
      statusRow.appendChild(btn);
      return btn;
    });
    const updateStatusBtns = () => {
      statusBtns.forEach((btn) => {
        btn.className =
          'opt-btn ' +
          (btn.dataset.value === selectedStatus
            ? 'opt-status'
            : 'opt-inactive');
      });
    };
    statusRow.insertBefore(statusLabel, statusRow.firstChild);
    advPanel.appendChild(statusRow);

    advToggle.addEventListener('click', () => {
      const isHidden = advPanel.classList.toggle('hidden');
      advToggle.textContent = isHidden ? '詳細 ▾' : '詳細 ▴';
    });

    // Expose selectedSender/Status via closures for send helpers
    this.#doSend = async () => {
      const content = msgInput.value.trim();
      if (!content) {
        msgInput.focus();
        return;
      }
      this.#setBusy(true);
      const payload: Record<string, string> = { content, from: selectedSender };
      if (selectedStatus) payload.status = selectedStatus;
      const res = await app.apiFetch(`/api/threads/${thread.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res) {
        this.#setBusy(false);
        return;
      }
      msgInput.value = '';
      this.#setBusy(false);
      await app.loadAll();
    };

    this.#doSendWithStatus = async (status: string) => {
      const content = msgInput.value.trim();
      if (!content) {
        msgInput.focus();
        return;
      }
      this.#setBusy(true);
      const res = await app.apiFetch(`/api/threads/${thread.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, from: 'user', status }),
      });
      if (!res) {
        this.#setBusy(false);
        return;
      }
      msgInput.value = '';
      this.#setBusy(false);
      await app.loadAll();
    };

    this.#doSendToManager = async () => {
      const content = msgInput.value.trim();
      if (!content) {
        msgInput.focus();
        return;
      }
      this.#setBusy(true);
      const addMessageRes = await app.apiFetch(
        `/api/threads/${thread.id}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, from: 'user', status: 'waiting' }),
        }
      );
      if (!addMessageRes) {
        this.#setBusy(false);
        return;
      }
      const sendRes = await app.apiFetch('/api/manager/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: thread.id, content }),
      });
      if (!sendRes) {
        this.#setBusy(false);
        return;
      }
      msgInput.value = '';
      app.managerPendingThreadId = thread.id;
      this.#setBusy(false);
      await app.loadAll();
      void app.loadManagerStatus();
    };

    actions.appendChild(managerBtn);
    actions.appendChild(needsReplyBtn);
    actions.appendChild(reviewBtn);
    actions.appendChild(sendBtn);
    actions.appendChild(pendingNote);
    actions.appendChild(hintSpan);
    actions.appendChild(advToggle);

    formArea.appendChild(msgInput);
    formArea.appendChild(actions);
    formArea.appendChild(advPanel);

    this.el = formArea;

    // Apply initial pending state
    ReplyForm.patchPending(formArea, thread, app.managerPendingThreadId);
  }

  #setBusy(busy: boolean): void {
    this.#sendBtn.disabled = busy;
    this.#needsReplyBtn.disabled = busy;
    this.#reviewBtn.disabled = busy;
    this.#managerBtn.disabled = busy;
  }

  // Suppress unused warning — fields assigned via closures in constructor
  get _msgInput() {
    return this.#msgInput;
  }
  get _pendingNote() {
    return this.#pendingNote;
  }

  static patchPending(
    formEl: Element | null,
    thread: Thread,
    pendingId: string | null
  ): void {
    if (!formEl) return;
    const managerBtn =
      formEl.querySelector<HTMLButtonElement>('[data-manager-btn]');
    const pendingNote = formEl.querySelector('[data-pending-note]');
    const isPending = pendingId === thread.id;
    if (managerBtn) {
      managerBtn.disabled = isPending;
      managerBtn.textContent = isPending
        ? '🤖 返信待ち中...'
        : '🤖 マネージャーに送る';
    }
    if (pendingNote) {
      if (isPending) {
        pendingNote.classList.remove('hidden');
      } else {
        pendingNote.classList.add('hidden');
      }
    }
  }
}

// ── DetailController ───────────────────────────────────────────────────────

class DetailController {
  #detailEl: HTMLElement;
  #app: ManagerApp;
  #currentThreadId: string | null = null;
  #renderedMsgCount = 0;

  constructor(detailEl: HTMLElement, app: ManagerApp) {
    this.#detailEl = detailEl;
    this.#app = app;
  }

  update(thread: Thread): void {
    const isNewThread = this.#currentThreadId !== thread.id;
    if (isNewThread) {
      this.#rebuild(thread);
    } else {
      this.#patch(thread);
    }
  }

  #rebuild(thread: Thread): void {
    this.#currentThreadId = thread.id;
    this.#renderedMsgCount = 0;

    this.#detailEl.innerHTML = '';
    this.#detailEl.classList.remove('hidden');

    // Header
    const header = document.createElement('div');
    header.className = 'detail-header';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.className = 'close-btn';
    closeBtn.title = '閉じる';
    closeBtn.addEventListener('click', () => this.#app.closeDetail());

    const titleEl = document.createElement('span');
    titleEl.className = 'detail-title';
    titleEl.setAttribute('data-detail-title', '');
    titleEl.textContent = thread.title;

    const badge = makeStatusBadge(thread.status);

    const actionBtn = this.#buildActionBtn(thread);

    header.appendChild(closeBtn);
    header.appendChild(titleEl);
    header.appendChild(badge);
    header.appendChild(actionBtn);
    this.#detailEl.appendChild(header);

    // Message area
    const msgArea = document.createElement('div');
    msgArea.className = 'msg-area';

    if (!thread.messages || thread.messages.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'msg-empty';
      empty.setAttribute('data-msg-empty', '');
      empty.textContent = 'メッセージなし。下から追加できます。';
      msgArea.appendChild(empty);
    } else {
      for (const msg of thread.messages) {
        msgArea.appendChild(makeBubble(msg));
      }
      this.#renderedMsgCount = thread.messages.length;
    }
    this.#detailEl.appendChild(msgArea);

    // Reply form
    const form = new ReplyForm(thread, this.#app);
    this.#detailEl.appendChild(form.el);

    // Scroll to bottom on rebuild
    setTimeout(() => {
      msgArea.scrollTop = msgArea.scrollHeight;
    }, 0);
  }

  #patch(thread: Thread): void {
    const msgArea = this.#detailEl.querySelector<HTMLElement>('.msg-area');

    // Check wasNearBottom BEFORE appending
    let wasNearBottom = true;
    if (msgArea) {
      const distFromBottom =
        msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight;
      wasNearBottom = distFromBottom <= 60;
    }

    const newMsgCount = thread.messages ? thread.messages.length : 0;
    const hasNewMessages = newMsgCount > this.#renderedMsgCount;

    // Update header badge if status changed
    const badge = this.#detailEl.querySelector<HTMLElement>(
      '[data-detail-badge]'
    );
    if (badge && badge.textContent !== thread.status) {
      const s = STATUS_STYLES[thread.status] || STATUS_STYLES['active'];
      badge.textContent = thread.status;
      badge.style.cssText = `background:${s.bg};color:${s.color};border:1px solid ${s.border};`;
    }

    // Update title if changed
    const titleEl = this.#detailEl.querySelector('[data-detail-title]');
    if (titleEl && titleEl.textContent !== thread.title) {
      titleEl.textContent = thread.title;
    }

    // Replace action button only if resolved state changed
    const existingActionBtn =
      this.#detailEl.querySelector<HTMLElement>('[data-action-btn]');
    if (existingActionBtn) {
      const wasResolved =
        existingActionBtn.dataset.actionBtnResolved === 'true';
      const isResolved = thread.status === 'resolved';
      if (wasResolved !== isResolved) {
        const newActionBtn = this.#buildActionBtn(thread);
        existingActionBtn.parentNode?.replaceChild(
          newActionBtn,
          existingActionBtn
        );
      }
    }

    // Append only new messages
    if (msgArea && hasNewMessages) {
      const newMsgs = (thread.messages ?? []).slice(this.#renderedMsgCount);
      // Remove empty placeholder if present
      const emptyEl = msgArea.querySelector('[data-msg-empty]');
      if (emptyEl) emptyEl.remove();
      for (const msg of newMsgs) {
        msgArea.appendChild(makeBubble(msg));
      }
      this.#renderedMsgCount = newMsgCount;

      if (
        shouldScrollToBottom({
          isFirstRender: false,
          hasNewMessages: true,
          wasNearBottom,
        })
      ) {
        setTimeout(() => {
          msgArea.scrollTop = msgArea.scrollHeight;
        }, 0);
      }
    }

    // Patch reply form pending state
    const formEl = this.#detailEl.querySelector('[data-reply-form]');
    ReplyForm.patchPending(formEl, thread, this.#app.managerPendingThreadId);
  }

  #buildActionBtn(thread: Thread): HTMLButtonElement {
    const actionBtn = document.createElement('button');
    actionBtn.setAttribute('data-action-btn', '');
    if (thread.status === 'resolved') {
      actionBtn.textContent = '↺ 再開';
      actionBtn.className = 'btn btn-reopen';
      actionBtn.dataset.actionBtnResolved = 'true';
      actionBtn.addEventListener('click', () => {
        void (async () => {
          const res = await this.#app.apiFetch(
            `/api/threads/${thread.id}/reopen`,
            {
              method: 'PUT',
            }
          );
          if (!res) return;
          await this.#app.loadAll();
        })();
      });
    } else {
      actionBtn.textContent = '✓ 解決';
      actionBtn.className = 'btn btn-resolve';
      actionBtn.dataset.actionBtnResolved = 'false';
      actionBtn.addEventListener('click', () => {
        void (async () => {
          const res = await this.#app.apiFetch(
            `/api/threads/${thread.id}/resolve`,
            {
              method: 'PUT',
            }
          );
          if (!res) return;
          await this.#app.loadAll();
          this.#app.closeDetail();
        })();
      });
    }
    return actionBtn;
  }

  clear(): void {
    this.#currentThreadId = null;
    this.#renderedMsgCount = 0;
    this.#detailEl.classList.add('hidden');
    this.#detailEl.innerHTML = '';
  }
}

// ── ManagerApp ─────────────────────────────────────────────────────────────

class ManagerApp {
  allThreads: Thread[] = [];
  allTasks: Task[] = [];
  openThreadId: string | null = null;
  managerPendingThreadId: string | null = null;

  #sectionControllers: Record<string, SectionController> = {};
  #taskController!: TaskSectionController;
  #detailController!: DetailController;
  #detailEl!: HTMLElement;
  #pollTimer: number | null = null;
  #authToken = readStoredAuthToken();
  #authRequired = MANAGER_AUTH_REQUIRED;

  constructor() {
    const sectionKeys = [
      'ai-replied',
      'needs-reply',
      'review',
      'waiting',
      'idle',
    ];
    for (const key of sectionKeys) {
      this.#sectionControllers[key] = new SectionController(key);
    }
    this.#taskController = new TaskSectionController();
    this.#detailEl = document.getElementById('thread-detail') as HTMLElement;
    this.#detailController = new DetailController(this.#detailEl, this);
  }

  init(): void {
    // Bootstrap auth from hash fragment (hub passes accessCode=… on redirect)
    try {
      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, '')
      );
      const hashToken = hashParams.get('accessCode');
      if (hashToken) {
        writeStoredAuthToken(hashToken);
        this.#authToken = hashToken;
        history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search
        );
      }
    } catch {
      /* ignore hash errors */
    }

    // Set dir label
    const dirLabel = document.getElementById('dir-label');
    if (dirLabel) dirLabel.textContent = GUI_DIR;
    this.#wireAuthPanel();

    // Wire data-action buttons
    document.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      switch (action) {
        case 'refresh':
          void this.loadAll();
          break;
        case 'new-thread':
          this.#showNewThreadForm();
          break;
        case 'create-thread':
          void this.#submitNewThread(false);
          break;
        case 'create-thread-manager':
          void this.#submitNewThread(true);
          break;
        case 'hide-new-thread':
          this.#hideNewThreadForm();
          break;
        case 'start-manager':
          void this.#doStartManager();
          break;
        case 'unlock-auth':
          void this.#unlockAuth();
          break;
        case 'clear-auth':
          this.#clearSavedAuth();
          break;
      }
    });

    // Wire data-section-key headers
    document.addEventListener('click', (e: MouseEvent) => {
      const header = (e.target as Element | null)?.closest(
        '[data-section-key]'
      );
      if (!header) return;
      const key = header.getAttribute('data-section-key');
      if (key) this.#toggleSection(key);
    });

    // Wire new-thread-title keydown
    const titleInput = document.getElementById(
      'new-thread-title'
    ) as HTMLInputElement | null;
    if (titleInput) {
      titleInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') void this.#submitNewThread(false);
        if (e.key === 'Escape') this.#hideNewThreadForm();
      });
    }

    if (this.#authRequired && !this.#authToken) {
      this.#showAuthPanel();
      return;
    }

    this.#hideAuthPanel();
    void this.#bootAfterAuth();
  }

  async apiFetch(
    input: string,
    init: RequestInit = {}
  ): Promise<Response | null> {
    try {
      return await apiFetchWithToken(this.#authToken, input, init);
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        this.#handleAuthFailure('アクセスコードを入力してください');
        return null;
      }
      throw e;
    }
  }

  async loadAll(): Promise<boolean> {
    try {
      const previousThreads = this.allThreads;
      const [threadsRes, tasksRes] = await Promise.all([
        this.apiFetch('/api/threads'),
        this.apiFetch('/api/tasks'),
      ]);
      if (!threadsRes || !tasksRes) {
        return false;
      }
      if (threadsRes.ok) {
        const fetchedThreads = (await threadsRes.json()) as Thread[];
        this.allThreads = this.#mergePendingThreads(
          previousThreads,
          fetchedThreads
        );
      }
      if (tasksRes.ok) this.allTasks = (await tasksRes.json()) as Task[];

      // Clear pending state when the manager has replied (last message is from AI)
      if (this.managerPendingThreadId) {
        const pt = this.allThreads.find(
          (t) => t.id === this.managerPendingThreadId
        );
        if (
          !pt ||
          (pt.messages &&
            pt.messages.length > 0 &&
            pt.messages[pt.messages.length - 1].sender === 'ai')
        ) {
          this.managerPendingThreadId = null;
        }
      }

      this.#renderAll();

      if (this.openThreadId) {
        const still = this.allThreads.find((t) => t.id === this.openThreadId);
        if (still) {
          this.#detailController.update(still);
        } else {
          this.closeDetail();
        }
      }
    } catch (e) {
      console.error('Failed to load data:', e);
      return false;
    }
    return true;
  }

  #mergePendingThreads(
    previousThreads: Thread[],
    fetchedThreads: Thread[]
  ): Thread[] {
    if (!this.managerPendingThreadId) {
      return fetchedThreads;
    }

    const pendingThread = previousThreads.find(
      (thread) => thread.id === this.managerPendingThreadId
    );
    if (!pendingThread) {
      return fetchedThreads;
    }

    if (fetchedThreads.some((thread) => thread.id === pendingThread.id)) {
      return fetchedThreads;
    }

    return [pendingThread, ...fetchedThreads];
  }

  async loadManagerStatus(): Promise<boolean> {
    try {
      const res = await this.apiFetch('/api/manager/status');
      if (!res || !res.ok) return false;
      const data = (await res.json()) as {
        running: boolean;
        configured: boolean;
        builtinBackend: boolean;
        detail?: string;
      };
      const dot = document.getElementById(
        'manager-status-dot'
      ) as HTMLElement | null;
      const text = document.getElementById(
        'manager-status-text'
      ) as HTMLElement | null;
      const startBtn = document.getElementById(
        'manager-start-btn'
      ) as HTMLElement | null;
      if (data.running) {
        const isBusy = data.detail && data.detail.includes('処理中');
        if (dot) dot.style.background = isBusy ? '#f59e0b' : '#22c55e';
        if (text) {
          text.style.color = isBusy ? '#fcd34d' : '#86efac';
          text.textContent =
            (isBusy
              ? 'マネージャーが返答を作成中です'
              : 'マネージャーは待機中です') +
            (data.detail ? ' — ' + data.detail : '');
        }
        startBtn?.classList.add('hidden');
      } else if (!data.configured) {
        if (dot) dot.style.background = '#4b5563';
        if (text) {
          text.style.color = '#6b7280';
          text.textContent = '外部マネージャー設定はありません';
        }
        startBtn?.classList.add('hidden');
      } else if (data.builtinBackend) {
        if (dot) dot.style.background = '#4b5563';
        if (text) {
          text.style.color = '#9ca3af';
          text.textContent =
            'まだ始まっていません。起動するか、そのまま送信してください';
        }
        startBtn?.classList.remove('hidden');
      } else {
        if (dot) dot.style.background = '#ef4444';
        if (text) {
          text.style.color = '#fca5a5';
          text.textContent =
            '止まっています。起動すると再開できます' +
            (data.detail ? ' — ' + data.detail : '');
        }
        startBtn?.classList.remove('hidden');
      }
    } catch {
      /* silently ignore */
      return false;
    }
    return true;
  }

  closeDetail(): void {
    this.openThreadId = null;
    this.#detailController.clear();
    this.#renderAll();
  }

  openDetail(id: string): void {
    this.openThreadId = id;
    this.#renderAll();
    const thread = this.allThreads.find((t) => t.id === id);
    if (thread) {
      this.#detailController.update(thread);
      this.#detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  #renderAll(): void {
    const groups = groupThreads(this.allThreads);
    this.#renderGettingStarted(groups);
    const onSelect = (id: string) => {
      if (this.openThreadId === id) {
        this.closeDetail();
      } else {
        this.openDetail(id);
      }
    };
    for (const key of [
      'ai-replied',
      'needs-reply',
      'review',
      'waiting',
      'idle',
    ]) {
      this.#sectionControllers[key].update(
        groups[key],
        this.openThreadId,
        onSelect
      );
    }
    this.#taskController.update(this.allTasks);
  }

  #renderGettingStarted(groups: Record<string, Thread[]>): void {
    const hero = document.getElementById('getting-started');
    if (!hero) return;
    const hasThreads = Object.values(groups).some((items) => items.length > 0);
    const hasTasks = this.allTasks.length > 0;
    hero.classList.toggle('hidden', hasThreads || hasTasks);
  }

  #toggleSection(key: string): void {
    if (key === 'tasks') {
      this.#taskController.toggle();
    } else if (this.#sectionControllers[key]) {
      this.#sectionControllers[key].toggle();
    }
  }

  #showNewThreadForm(): void {
    document.getElementById('new-thread-form')?.classList.remove('hidden');
    setTimeout(
      () =>
        (
          document.getElementById('new-thread-title') as HTMLElement | null
        )?.focus(),
      0
    );
  }

  #hideNewThreadForm(): void {
    document.getElementById('new-thread-form')?.classList.add('hidden');
    const titleInput = document.getElementById(
      'new-thread-title'
    ) as HTMLInputElement | null;
    if (titleInput) titleInput.value = '';
  }

  async #submitNewThread(sendToManager: boolean): Promise<void> {
    const titleInput = document.getElementById(
      'new-thread-title'
    ) as HTMLInputElement | null;
    if (!titleInput) return;
    const title = titleInput.value.trim();
    if (!title) {
      titleInput.focus();
      return;
    }
    const res = await this.apiFetch('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (res?.ok) {
      const thread = (await res.json()) as Thread;
      this.#hideNewThreadForm();
      let optimisticThread = thread;
      if (sendToManager) {
        const addMessageRes = await this.apiFetch(
          `/api/threads/${thread.id}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: title,
              from: 'user',
              status: 'waiting',
            }),
          }
        );
        if (!addMessageRes) return;
        const sendRes = await this.apiFetch('/api/manager/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: thread.id, content: title }),
        });
        if (!sendRes) return;
        this.managerPendingThreadId = thread.id;
        optimisticThread = {
          ...thread,
          status: 'waiting',
          updatedAt: new Date().toISOString(),
          messages: [
            ...(thread.messages ?? []),
            {
              sender: 'user',
              content: title,
              at: new Date().toISOString(),
            },
          ],
        };
        void this.loadManagerStatus();
      }
      this.allThreads = [
        optimisticThread,
        ...this.allThreads.filter((existing) => existing.id !== thread.id),
      ];
      this.openDetail(thread.id);
      await this.loadAll();
    }
  }

  async #doStartManager(): Promise<void> {
    const btn = document.getElementById(
      'manager-start-btn'
    ) as HTMLButtonElement | null;
    const text = document.getElementById(
      'manager-status-text'
    ) as HTMLElement | null;
    if (btn) btn.disabled = true;
    if (text) text.textContent = '起動しています...';
    try {
      const res = await this.apiFetch('/api/manager/start', { method: 'POST' });
      if (!res) return;
      const data = (await res.json()) as { started: boolean; detail?: string };
      if (data.started) {
        if (text) {
          text.style.color = '#86efac';
          text.textContent = '起動しました — ' + (data.detail || '');
        }
      } else {
        if (text) {
          text.style.color = '#fca5a5';
          text.textContent = '起動失敗: ' + (data.detail || '不明なエラー');
        }
      }
    } catch (e) {
      if (text) text.textContent = '起動エラー: ' + (e as Error).message;
    } finally {
      if (btn) btn.disabled = false;
      setTimeout(() => void this.loadManagerStatus(), 1500);
    }
  }

  async #bootAfterAuth(): Promise<void> {
    const [dataOk, statusOk] = await Promise.all([
      this.loadAll(),
      this.loadManagerStatus(),
    ]);
    if (!dataOk && !statusOk) {
      return;
    }
    this.#startPolling();
  }

  #startPolling(): void {
    if (this.#pollTimer !== null) {
      return;
    }
    this.#pollTimer = window.setInterval(() => {
      const active = document.activeElement;
      const isTyping =
        active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (isTyping && this.managerPendingThreadId === null) return;
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

  #wireAuthPanel(): void {
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.#unlockAuth();
      }
    });
    if (this.#authToken) {
      input.value = this.#authToken;
      this.#toggleClearAuthButton(true);
    }
  }

  async #unlockAuth(): Promise<void> {
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    const submitBtn = document.querySelector<HTMLButtonElement>(
      '[data-action="unlock-auth"]'
    );
    const token = input?.value.trim();
    if (!token) {
      this.#setAuthError('アクセスコードを入力してください');
      input?.focus();
      return;
    }
    submitBtn?.setAttribute('disabled', 'true');
    this.#authToken = token;
    writeStoredAuthToken(token);
    this.#toggleClearAuthButton(true);
    this.#setAuthError('');
    const statusOk = await this.loadManagerStatus();
    const dataOk = await this.loadAll();
    submitBtn?.removeAttribute('disabled');
    if (statusOk || dataOk) {
      this.#hideAuthPanel();
      this.#startPolling();
      return;
    }
    this.#setAuthError('アクセスコードを確認してください');
  }

  #clearSavedAuth(): void {
    this.#authToken = null;
    clearStoredAuthToken();
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.focus();
    }
    this.#toggleClearAuthButton(false);
    this.#setAuthError('');
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
      .forEach((el) => {
        el.classList.add('auth-hidden');
      });
    this.#setAuthError(message);
    this.#toggleClearAuthButton(Boolean(readStoredAuthToken()));
    const input = document.getElementById(
      'auth-token-input'
    ) as HTMLInputElement | null;
    if (input && !input.value) {
      input.focus();
    }
  }

  #hideAuthPanel(): void {
    document.getElementById('auth-panel')?.classList.add('hidden');
    document
      .querySelectorAll<HTMLElement>('[data-auth-content]')
      .forEach((el) => {
        el.classList.remove('auth-hidden');
      });
    this.#setAuthError('');
  }

  #setAuthError(message: string): void {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
      errorEl.textContent = message;
    }
  }

  #toggleClearAuthButton(visible: boolean): void {
    const btn = document.getElementById('auth-clear-btn');
    if (!btn) return;
    btn.classList.toggle('hidden', !visible);
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

export { ManagerApp };

export function bootstrapManagerApp(): ManagerApp {
  const app = new ManagerApp();
  app.init();
  return app;
}

bootstrapManagerApp();
