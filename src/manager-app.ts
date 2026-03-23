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
  pendingCount?: number;
  currentQueueId?: string | null;
  currentThreadId?: string | null;
  currentThreadTitle?: string | null;
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
  'ai-working': 'AI作業中',
  done: '完了',
};

const STATE_EMPTY_COPY: Record<ManagerUiState, string> = {
  'routing-confirmation-needed': '振り分け確認が必要な task はありません',
  'user-reply-needed': 'あなたの返信が必要な task はありません',
  'ai-finished-awaiting-user-confirmation':
    'あなたに確認してほしい返答はありません',
  queued: 'まだ着手していない task はありません',
  'ai-working': 'AI が作業中の task はありません',
  done: '完了済みの task はありません',
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

const COMPOSER_FEEDBACK_DISMISS_MS = 4800;

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

function hashMessageContent(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
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

function renderMessageMarkdown(target: HTMLElement, raw: string): void {
  const parsed = parseManagerMessage(raw);
  const html = String(
    marked.parse(parsed.markdown, { gfm: true, breaks: true })
  );
  const template = document.createElement('template');
  template.innerHTML = html;
  const attachments = new Map(
    parsed.attachments.map((attachment) => [attachment.id, attachment])
  );
  target.replaceChildren(
    sanitizeMarkdownChildren(document, template.content, attachments)
  );
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
  bubble.dataset.messageKey = `${message.sender}|${message.at ?? ''}|${hashMessageContent(message.content)}`;
  bubble.dataset.chatSide = ai ? 'left' : 'right';
  bubble.dataset.sender = message.sender;

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';

  const sender = document.createElement('span');
  sender.className = `bubble-sender ${ai ? 'bubble-sender-ai' : 'bubble-sender-user'}`;
  sender.textContent = ai ? 'AI' : 'あなた';

  const timestamp = document.createElement('span');
  timestamp.className = 'bubble-ts';
  timestamp.textContent = formatDate(message.at);

  const content = document.createElement('div');
  content.className = 'bubble-content';
  renderMessageMarkdown(content, message.content);

  meta.append(sender, timestamp);
  bubble.append(meta, content);
  return bubble;
}

function messagesForDetail(messages: Msg[]): Msg[] {
  return [...messages].reverse();
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
      'この task だけ、どの task として扱うかをあなたに確認したい状態です。'
    );
  }
  if (thread.uiState === 'user-reply-needed') {
    return 'AI が続きに必要な確認を待っています。返事をすると上から優先的に処理します。';
  }
  if (thread.uiState === 'ai-finished-awaiting-user-confirmation') {
    return 'AI の中では一区切りついています。内容を確認して、追加があればそのまま送り、終わりなら完了にしてください。';
  }
  if (thread.uiState === 'ai-working') {
    return 'いま AI がこの task の作業を実行中です。結果が返ると自動で上の優先度へ移動します。';
  }
  if (thread.uiState === 'queued') {
    return 'この task はまだ未着手です。AI が順番に取りかかります。';
  }
  if (thread.uiState === 'done') {
    return 'この task は完了として閉じています。必要ならもう一度開けます。';
  }
  return null;
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

function threadStateLocation(thread: ThreadView): string {
  return `一覧では「${STATE_LABELS[thread.uiState]}」にあります`;
}

function composerActionLabel(thread: ThreadView): string {
  return thread.uiState === 'ai-working'
    ? 'この task に追加指示を送る'
    : 'この task に送る';
}

function composerSendButtonLabel(thread: ThreadView | null): string {
  if (!thread) {
    return '送る';
  }
  return thread.uiState === 'ai-working' ? '追加指示を送る' : '送る';
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
  #lastTargetThreadId: string | null = null;
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
        this.#lastTargetThreadId,
        this.#lastSelectHandler
      );
    }
  }

  update(
    threads: ThreadView[],
    openThreadId: string | null,
    targetThreadId: string | null,
    onSelect: ((id: string) => void) | null
  ): void {
    this.#lastThreads = threads;
    this.#lastOpenThreadId = openThreadId;
    this.#lastTargetThreadId = targetThreadId;
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
        this.#patchRow(existing, thread, openThreadId, targetThreadId);
      } else {
        this.#rows.set(
          thread.id,
          this.#buildRow(thread, openThreadId, targetThreadId, onSelect)
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

    const target = document.createElement('span');
    target.className = 'thread-open-indicator thread-target-indicator';
    target.dataset.rowTarget = '';
    target.textContent = '送信先';
    target.classList.toggle('hidden', targetThreadId !== thread.id);

    const preview = document.createElement('div');
    preview.className = 'thread-preview';
    preview.dataset.rowPreview = '';
    preview.textContent = thread.previewText || 'まだやり取りはありません';

    top.append(badge, title, age, target, detailToggle);
    row.append(top, preview);

    if (thread.routingHint) {
      const note = document.createElement('div');
      note.className = 'thread-note';
      note.dataset.rowNote = '';
      note.textContent = thread.routingHint;
      row.appendChild(note);
    }

    const detailHost = document.createElement('div');
    detailHost.className = 'thread-inline-detail-host hidden';
    detailHost.dataset.rowDetailHost = '';
    row.appendChild(detailHost);

    row.addEventListener('click', () => {
      onSelect?.(thread.id);
    });
    return row;
  }

  #patchRow(
    row: HTMLElement,
    thread: ThreadView,
    openThreadId: string | null,
    targetThreadId: string | null
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

    const target = row.querySelector<HTMLElement>('[data-row-target]');
    target?.classList.toggle('hidden', targetThreadId !== thread.id);

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

    const detailHost = row.querySelector<HTMLElement>('[data-row-detail-host]');
    if (detailHost) {
      detailHost.classList.toggle('hidden', openThreadId !== thread.id);
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
  #parkingEl: HTMLElement;
  #app: ManagerApp;
  #currentThreadId: string | null = null;
  #lastRenderedSignature: string | null = null;

  constructor(detailEl: HTMLElement, parkingEl: HTMLElement, app: ManagerApp) {
    this.#detailEl = detailEl;
    this.#parkingEl = parkingEl;
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

  render(
    thread: ThreadView | null,
    hostEl: HTMLElement | null,
    movementNotice: string | null
  ): void {
    if (!thread || !hostEl) {
      this.clear();
      return;
    }

    const nextSignature = JSON.stringify({
      id: thread.id,
      title: thread.title,
      uiState: thread.uiState,
      updatedAt: thread.updatedAt ?? '',
      queueDepth: thread.queueDepth,
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
    if (this.#detailEl.parentElement !== hostEl) {
      hostEl.appendChild(this.#detailEl);
    }
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
    focusComposer.textContent = composerActionLabel(thread);
    focusComposer.addEventListener('click', () =>
      this.#app.focusComposerForThread(thread.id)
    );
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
    const detailMessages = messagesForDetail(thread.messages);
    if (detailMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'detail-empty';
      empty.textContent =
        'まだやり取りはありません。下の送信ボタンを開くと最初のメッセージを送れます。';
      msgArea.appendChild(empty);
    } else {
      for (const message of detailMessages) {
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
      '<div class="detail-empty">task を開くと、ここにやり取りの流れが固定表示されます。</div>';
    if (this.#detailEl.parentElement !== this.#parkingEl) {
      this.#parkingEl.appendChild(this.#detailEl);
    }
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
  #detail: DetailController;
  #authToken = readStoredAuthToken();
  #pollTimer: number | null = null;
  #showDone = false;
  #sending = false;
  #managerStatus: ManagerStatusPayload | null = null;
  #composerDock: HTMLElement | null = null;
  #composerResizeObserver: ResizeObserver | null = null;
  #composerExpanded = false;
  #composerAttachments = new Map<string, ManagerMessageAttachment>();
  #composerAttachmentSerial = 0;
  #composerFeedbackTimer: number | null = null;

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
      document.getElementById('thread-detail-parking') as HTMLElement,
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
    this.#renderComposerExpansionState();
    this.#syncComposerDraftUi();

    if (MANAGER_AUTH_REQUIRED && !this.#authToken) {
      this.#showAuthPanel();
      return;
    }

    this.#hideAuthPanel();
    void this.#bootAfterAuth();
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

  #composerInput(): HTMLTextAreaElement | null {
    return document.getElementById(
      'globalComposerInput'
    ) as HTMLTextAreaElement | null;
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
    this.#renderComposerPreview(markdown);
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

  #renderComposerPreview(markdown: string): void {
    const previewWrap = document.getElementById('composerPreviewWrap');
    const previewBody = document.getElementById('composerPreviewBody');
    if (!previewWrap || !previewBody) {
      return;
    }

    if (!markdown.trim()) {
      previewWrap.classList.add('hidden');
      previewBody.replaceChildren();
      return;
    }

    previewWrap.classList.remove('hidden');
    renderMessageMarkdown(
      previewBody,
      this.#serializedComposerContent(markdown)
    );
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

  #insertTextAtCursor(input: HTMLTextAreaElement, text: string): void {
    const selectionStart = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    input.setRangeText(text, selectionStart, selectionEnd, 'end');
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

  async #insertComposerImages(files: FileList | File[]): Promise<void> {
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

    this.#insertTextAtCursor(input, insertions.join('\n'));
    this.#syncComposerDraftUi();
    input.focus();
  }

  closeDetail(): void {
    if (this.#composerTargetThreadId === this.openThreadId) {
      this.#composerTargetThreadId = null;
    }
    this.openThreadId = null;
    this.#openThreadMovementNotice = null;
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
    const previousOpenThread = this.#findThread(this.openThreadId);
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
      if (this.#composerTargetThreadId === this.openThreadId) {
        this.#composerTargetThreadId = null;
      }
      this.openThreadId = null;
      this.#openThreadMovementNotice = null;
    }

    if (
      this.#composerTargetThreadId &&
      !this.allThreads.some(
        (thread) => thread.id === this.#composerTargetThreadId
      )
    ) {
      this.#composerTargetThreadId = null;
    }

    const nextOpenThread = this.#findThread(this.openThreadId);
    if (
      previousOpenThread &&
      nextOpenThread &&
      previousOpenThread.uiState !== nextOpenThread.uiState
    ) {
      this.#openThreadMovementNotice = `この task は「${STATE_LABELS[previousOpenThread.uiState]}」から「${STATE_LABELS[nextOpenThread.uiState]}」に移動しました。`;
      if (nextOpenThread.uiState === 'done') {
        this.#showDone = true;
        this.#renderDoneToggle();
      }
    } else if (!nextOpenThread) {
      this.#openThreadMovementNotice = null;
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
      const busy = managerStatusBusy(payload);
      if (dot) {
        dot.style.background = busy ? '#f59e0b' : '#22c55e';
      }
      if (text) {
        text.style.color = busy ? '#92400e' : '#166534';
        const label = busy
          ? payload.currentThreadTitle
            ? `AI が「${payload.currentThreadTitle}」を処理中です`
            : 'AI が作業中です'
          : '待機中です';
        const queueTail =
          !busy && (payload.pendingCount ?? 0) > 0
            ? ` — キュー ${payload.pendingCount} 件`
            : payload.detail
              ? ` — ${payload.detail}`
              : '';
        text.textContent = `${label}${queueTail}`;
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
        text.style.color = '#334155';
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
      text.style.color = '#b91c1c';
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

  #findThread(threadId: string | null): ThreadView | null {
    if (!threadId) {
      return null;
    }
    return this.allThreads.find((item) => item.id === threadId) ?? null;
  }

  #focusThread(threadId: string): void {
    this.openThreadId = threadId;
    this.#openThreadMovementNotice = null;
    const thread = this.allThreads.find((item) => item.id === threadId) ?? null;
    if (thread?.uiState === 'done') {
      this.#showDone = true;
      this.#renderDoneToggle();
    }
    this.#renderAll();
    this.#scrollOpenThreadIntoViewIfNeeded();
  }

  #scrollOpenThreadIntoViewIfNeeded(): void {
    const row = this.#getRowForThread(this.openThreadId);
    if (!row) {
      return;
    }

    const rect = row.getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    if (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= viewportHeight &&
      rect.width > 0 &&
      rect.height > 0
    ) {
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  #getRowForThread(threadId: string | null): HTMLElement | null {
    if (!threadId) {
      return null;
    }
    for (const state of STATE_ORDER) {
      const row = this.#sections[state].getRow(threadId);
      if (row) {
        return row;
      }
    }
    return null;
  }

  #setComposerTarget(threadId: string | null): void {
    const nextThread =
      threadId === null
        ? null
        : (this.allThreads.find((item) => item.id === threadId) ?? null);
    this.#composerTargetThreadId = nextThread?.id ?? null;
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
    const input = this.#composerInput();
    if (!input) {
      return;
    }
    const markdown = input.value.replace(/\r\n?/g, '\n').trim();
    const content = this.#serializedComposerContent(markdown);
    if (!content || this.#sending) {
      if (!markdown) {
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
    this.#clearComposerFeedback();
    if (statusText) {
      statusText.textContent = '振り分けています…';
    }

    const response = await this.apiFetch('/api/manager/global-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        contextThreadId: this.#composerTargetThreadId,
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
    this.#composerAttachments.clear();
    this.#syncComposerDraftUi();
    if (statusText) {
      statusText.textContent = summary.detail;
    }
    await Promise.all([this.loadAll(), this.loadManagerStatus()]);
    this.#setComposerExpanded(false);
    this.#renderComposerFeedback(summary);
    this.#scheduleComposerFeedbackDismiss();
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
    const fallback = 116;
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
        case 'toggle-composer':
          this.#setComposerExpanded(!this.#composerExpanded);
          if (this.#composerExpanded) {
            this.focusComposer();
          }
          break;
        case 'close-composer':
          this.#setComposerExpanded(false);
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
    composerInput?.addEventListener('input', () => {
      this.#syncComposerDraftUi();
    });
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

    const composerImageButton = document.getElementById(
      'composerInsertImageButton'
    ) as HTMLButtonElement | null;
    const composerImageInput = document.getElementById(
      'composerImageInput'
    ) as HTMLInputElement | null;
    composerImageButton?.addEventListener('click', () => {
      composerImageInput?.click();
    });
    composerImageInput?.addEventListener('change', () => {
      const files = composerImageInput.files;
      if (files && files.length > 0) {
        void this.#insertComposerImages(files);
      }
      composerImageInput.value = '';
    });

    const composerTargetClear = document.getElementById(
      'composerTargetClearButton'
    ) as HTMLButtonElement | null;
    composerTargetClear?.addEventListener('click', () => {
      this.#setComposerTarget(null);
      this.#renderAll();
      this.focusComposer();
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
    if (panel) {
      panel.classList.toggle('hidden', !this.#composerExpanded);
    }
    if (toggle) {
      toggle.textContent = this.#composerExpanded
        ? '送信欄を閉じる'
        : '送信欄を開く';
      toggle.setAttribute('aria-expanded', String(this.#composerExpanded));
    }
    this.#composerDock?.classList.toggle(
      'composer-dock-expanded',
      this.#composerExpanded
    );
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
      this.#sections[state].update(
        threads,
        this.openThreadId,
        this.#composerTargetThreadId,
        onSelect
      );
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
    this.#renderPriorityLane();
    this.#renderComposerExpansionState();
    this.#renderComposerTargetBar();
    this.#renderComposerContext();

    const openThread =
      this.openThreadId === null
        ? null
        : (this.allThreads.find((thread) => thread.id === this.openThreadId) ??
          null);
    const openThreadRow = this.#getRowForThread(this.openThreadId);
    this.#detail.render(
      openThread,
      openThreadRow?.querySelector<HTMLElement>('[data-row-detail-host]') ??
        null,
      this.#openThreadMovementNotice
    );
  }

  #renderPriorityLane(): void {
    const list = document.getElementById('priority-lane-list');
    const copy = document.getElementById('priority-lane-copy');
    if (!list || !copy) {
      return;
    }

    list.innerHTML = '';
    const threads = this.allThreads.filter(
      (thread) => thread.uiState !== 'done'
    );

    if (threads.length === 0) {
      copy.textContent =
        'まだ見るべき task はありません。下の送信ボタンからまとめて送ると、ここに優先順で並びます。';
      const empty = document.createElement('div');
      empty.className = 'focus-empty';
      empty.textContent = 'いま優先して見る task はありません。';
      list.appendChild(empty);
      return;
    }

    copy.textContent =
      'まずは上から順に見れば、返事が必要なものや確認すべきものを見失いにくくなり、開いた詳細もその task の行で追えます。';

    for (const thread of threads.slice(0, 4)) {
      const button = document.createElement('button');
      button.className = 'focus-list-item btn-ghost';
      button.type = 'button';
      button.classList.toggle('current', thread.id === this.openThreadId);
      button.addEventListener('click', () => {
        this.#focusThread(thread.id);
      });

      const top = document.createElement('div');
      top.className = 'focus-list-item-top';
      top.append(
        makeStateBadge(thread.uiState),
        Object.assign(document.createElement('div'), {
          className: 'focus-list-item-title',
          textContent: thread.title,
        })
      );

      const meta = document.createElement('div');
      meta.className = 'focus-list-item-meta';
      meta.textContent = `${thread.previewText} / ${threadStateLocation(thread)} / 更新 ${formatAge(thread.updatedAt)}`;

      button.append(top, meta);
      list.appendChild(button);
    }
  }

  #renderComposerTargetBar(): void {
    const label = document.getElementById('composerLabel');
    const hint = document.getElementById('composerHint');
    const pill = document.getElementById('composerTargetPill');
    const sendButton = document.getElementById(
      'globalComposerSendButton'
    ) as HTMLButtonElement | null;
    const clearButton = document.getElementById(
      'composerTargetClearButton'
    ) as HTMLButtonElement | null;
    if (!pill) {
      return;
    }
    const thread = this.#findThread(this.#composerTargetThreadId);
    if (!thread) {
      if (label) {
        label.textContent = 'AI へ送る';
      }
      if (hint) {
        hint.textContent =
          '一覧を見て、書くときだけ送信欄を開けます。AI が既存 task への追記・新しい task・確認待ちに分けます。';
      }
      pill.textContent = '送信先: 全体（AI が振り分けます）';
      if (sendButton) {
        sendButton.textContent = composerSendButtonLabel(null);
      }
      clearButton?.classList.add('hidden');
      return;
    }
    if (label) {
      label.textContent = composerActionLabel(thread);
    }
    if (hint) {
      hint.textContent =
        thread.uiState === 'ai-working'
          ? 'いま AI がこの task を進めています。ここへ送る内容は追加指示として順番待ちに入り、今の処理のあと自動で続きます。'
          : 'いま選んでいる @task に優先して送ります。全体へ戻すと、AI がもう一度 task を振り分けます。';
    }
    pill.textContent =
      thread.uiState === 'ai-working'
        ? `送信先: @${thread.title}（追加指示として送る）`
        : `送信先: @${thread.title}`;
    if (sendButton) {
      sendButton.textContent = composerSendButtonLabel(thread);
    }
    clearButton?.classList.remove('hidden');
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

    const busy = managerStatusBusy(this.#managerStatus);
    const running = this.#managerStatus?.running ?? false;
    const configured = this.#managerStatus?.configured ?? false;
    const currentThreadTitle = this.#managerStatus?.currentThreadTitle ?? null;
    const pendingCount = this.#managerStatus?.pendingCount ?? 0;

    if (busy) {
      primary.textContent = currentThreadTitle
        ? `AI が「${currentThreadTitle}」を進めています`
        : 'AI が作業や振り分けを進めています';
    } else if (counts['routing-confirmation-needed'] > 0) {
      primary.textContent = '振り分け確認が必要な task があります';
    } else if (counts['user-reply-needed'] > 0) {
      primary.textContent = 'あなたの返信待ちがあります';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      primary.textContent = 'AI から返答が来ています';
    } else if (counts['queued'] > 0) {
      primary.textContent = 'まだ着手していない task があります';
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
        pendingCount > 0
          ? `いまの task が終わると、残り ${pendingCount} 件を順番に進めます。結果が返ると一覧の上へ上がります。`
          : 'いまの task を実行中です。返答できる状態になると一覧の上へ上がります。';
    } else if (running) {
      detail.textContent =
        pendingCount > 0
          ? `いまは待機中ですが、キューに ${pendingCount} 件あります。少し待つと動きます。`
          : 'いまは待機中です。新しい内容を送れば、ここから自動で動きます。';
    } else if (configured) {
      detail.textContent =
        'まだ始まっていません。下の送信ボタンを開いて送れば自動で起動します。';
    } else if (counts['user-reply-needed'] > 0) {
      detail.textContent =
        '上から順に開けば、いま返した方がいい task から見られます。';
    } else if (counts['ai-finished-awaiting-user-confirmation'] > 0) {
      detail.textContent =
        'AI が返答済みです。確認したいものから順に開いてください。';
    } else {
      detail.textContent =
        '送った内容は task ごとに分かれて、ここで今の状況が見えるようになります。';
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
        label: 'AI作業中',
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
    const thread = this.#findThread(this.#composerTargetThreadId);
    if (thread && thread.uiState !== 'done') {
      context.classList.remove('hidden');
      context.textContent =
        thread.uiState === 'ai-working'
          ? `この送信は @${thread.title} の追加指示として順番待ちに入ります。`
          : `この送信は @${thread.title} を優先します。`;
      return;
    }
    context.textContent = '';
    context.classList.add('hidden');
  }

  #clearComposerFeedback(): void {
    if (this.#composerFeedbackTimer !== null) {
      window.clearTimeout(this.#composerFeedbackTimer);
      this.#composerFeedbackTimer = null;
    }

    const statusText = document.getElementById('composerStatusText');
    if (statusText) {
      statusText.textContent = '';
    }

    const feedback = document.getElementById('composerFeedback');
    if (!feedback) {
      return;
    }

    feedback.innerHTML = '';
    feedback.classList.add('hidden');
  }

  #scheduleComposerFeedbackDismiss(): void {
    if (this.#composerFeedbackTimer !== null) {
      window.clearTimeout(this.#composerFeedbackTimer);
    }
    this.#composerFeedbackTimer = window.setTimeout(() => {
      this.#composerFeedbackTimer = null;
      this.#clearComposerFeedback();
    }, COMPOSER_FEEDBACK_DISMISS_MS);
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
