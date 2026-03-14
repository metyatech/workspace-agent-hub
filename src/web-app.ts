/// <reference lib="dom" />

import type {
  DirectorySuggestion,
  SessionRecord,
  SessionTranscript,
  WebUiConfigBootstrap,
} from './types.js';

declare global {
  interface Window {
    WORKSPACE_AGENT_HUB_CONFIG: WebUiConfigBootstrap;
  }
}

const config = window.WORKSPACE_AGENT_HUB_CONFIG;
const authStorageKey = config.authStorageKey;

const sessionsList = document.querySelector<HTMLDivElement>('#sessionsList')!;
const refreshSessionsButton = document.querySelector<HTMLButtonElement>(
  '#refreshSessionsButton'
)!;
const sessionTypeSelect =
  document.querySelector<HTMLSelectElement>('#sessionTypeSelect')!;
const sessionTitleInput =
  document.querySelector<HTMLInputElement>('#sessionTitleInput')!;
const workingDirectoryInput = document.querySelector<HTMLInputElement>(
  '#workingDirectoryInput'
)!;
const workingDirectorySuggestions = document.querySelector<HTMLDataListElement>(
  '#workingDirectorySuggestions'
)!;
const startSessionButton = document.querySelector<HTMLButtonElement>(
  '#startSessionButton'
)!;
const showArchivedButton = document.querySelector<HTMLButtonElement>(
  '#showArchivedButton'
)!;
const selectedSessionState = document.querySelector<HTMLSpanElement>(
  '#selectedSessionState'
)!;
const selectedSessionSummary = document.querySelector<HTMLDivElement>(
  '#selectedSessionSummary'
)!;
const selectedSessionControls = document.querySelector<HTMLDivElement>(
  '#selectedSessionControls'
)!;
const sessionTranscript =
  document.querySelector<HTMLPreElement>('#sessionTranscript')!;
const sessionPromptInput = document.querySelector<HTMLTextAreaElement>(
  '#sessionPromptInput'
)!;
const sendPromptButton =
  document.querySelector<HTMLButtonElement>('#sendPromptButton')!;
const sendRawButton =
  document.querySelector<HTMLButtonElement>('#sendRawButton')!;
const renameSessionButton = document.querySelector<HTMLButtonElement>(
  '#renameSessionButton'
)!;
const archiveSessionButton = document.querySelector<HTMLButtonElement>(
  '#archiveSessionButton'
)!;
const interruptSessionButton = document.querySelector<HTMLButtonElement>(
  '#interruptSessionButton'
)!;
const closeSessionButton = document.querySelector<HTMLButtonElement>(
  '#closeSessionButton'
)!;
const deleteSessionButton = document.querySelector<HTMLButtonElement>(
  '#deleteSessionButton'
)!;
const connectionHint =
  document.querySelector<HTMLSpanElement>('#connectionHint')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const authOverlay = document.querySelector<HTMLDivElement>('#authOverlay')!;
const authTokenInput =
  document.querySelector<HTMLInputElement>('#authTokenInput')!;
const authSubmitButton =
  document.querySelector<HTMLButtonElement>('#authSubmitButton')!;

const sessionRows = new Map<string, HTMLDivElement>();

let sessions: SessionRecord[] = [];
let selectedSessionName = '';
let includeArchived = false;
let transcriptPollTimer: number | null = null;
let sessionPollTimer: number | null = null;
let lastTranscript = '';
let authToken = readStoredAuthToken();
let refreshPauseDepth = 0;

class AuthRequiredError extends Error {
  constructor() {
    super('Access code required');
    this.name = 'AuthRequiredError';
  }
}

function readStoredAuthToken(): string | null {
  try {
    const token = window.localStorage.getItem(authStorageKey);
    return token && token.trim() ? token : null;
  } catch {
    return null;
  }
}

function writeStoredAuthToken(token: string): void {
  try {
    window.localStorage.setItem(authStorageKey, token);
  } catch {
    /* ignore */
  }
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 2400);
}

function setBusy(
  button: HTMLButtonElement,
  busy: boolean,
  busyText: string
): void {
  if (!button.dataset.originalText) {
    button.dataset.originalText = button.textContent ?? '';
  }
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.originalText;
}

function setAuthOverlayVisible(visible: boolean): void {
  authOverlay.classList.toggle('visible', visible);
  authOverlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) {
    authTokenInput.focus();
  }
}

async function apiFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (authToken) {
    headers.set('X-Workspace-Agent-Hub-Token', authToken);
  }
  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    throw new AuthRequiredError();
  }
  return response;
}

async function apiJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Request failed with status ${response.status}`
    );
  }
  return (await response.json()) as T;
}

function sessionIsVisible(session: SessionRecord): boolean {
  return includeArchived ? true : session.IsLive && !session.Archived;
}

function getSelectedSession(): SessionRecord | undefined {
  return sessions.find((session) => session.Name === selectedSessionName);
}

function isRefreshPaused(): boolean {
  return refreshPauseDepth > 0;
}

async function withRefreshPause<T>(work: () => Promise<T>): Promise<T> {
  refreshPauseDepth += 1;
  try {
    return await work();
  } finally {
    refreshPauseDepth = Math.max(0, refreshPauseDepth - 1);
  }
}

function makeBadge(className: string, label: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `badge ${className}`;
  span.textContent = label;
  return span;
}

function patchSessionCard(card: HTMLDivElement, session: SessionRecord): void {
  card.dataset.sessionName = session.Name;
  card.classList.toggle('selected', session.Name === selectedSessionName);
  card.innerHTML = '';

  const title = document.createElement('h3');
  title.className = 'session-title';
  title.textContent = session.DisplayTitle;

  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';
  statusRow.appendChild(
    makeBadge(
      session.IsLive ? 'live' : 'closed',
      session.IsLive ? 'Running' : 'Closed'
    )
  );
  if (session.Archived) {
    statusRow.appendChild(makeBadge('archived', 'Hidden'));
  }

  const preview = document.createElement('div');
  preview.className = 'session-preview';
  preview.textContent = session.PreviewText || 'まだ出力はありません';

  const folder = document.createElement('div');
  folder.className = 'session-folder';
  folder.textContent = session.WorkingDirectoryWindows || config.workspaceRoot;

  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.textContent = `${session.Type.toUpperCase()} / 最終更新 ${session.LastActivityLocal}`;

  card.append(title, statusRow, preview, folder, meta);
}

function renderSessions(nextSessions: SessionRecord[]): void {
  const visibleSessions = nextSessions
    .filter(sessionIsVisible)
    .sort((left, right) => right.SortUnix - left.SortUnix);
  sessionsList.innerHTML = '';

  if (visibleSessions.length === 0) {
    sessionsList.innerHTML =
      '<div class="empty-state">まだ session がありません。左上から新しい session を始めてください。</div>';
    if (selectedSessionName) {
      selectedSessionName = '';
      renderSelectedSession();
    }
    return;
  }

  for (const session of visibleSessions) {
    let card = sessionRows.get(session.Name);
    if (!card) {
      card = document.createElement('div');
      card.className = 'session-card';
      card.addEventListener('click', () => {
        selectedSessionName = session.Name;
        renderSessions(sessions);
        renderSelectedSession();
      });
      sessionRows.set(session.Name, card);
    }
    patchSessionCard(card, session);
    sessionsList.appendChild(card);
  }

  if (
    selectedSessionName &&
    !visibleSessions.some((session) => session.Name === selectedSessionName)
  ) {
    selectedSessionName = '';
    renderSelectedSession();
  }
}

function upsertSession(nextSession: SessionRecord): void {
  const remaining = sessions.filter(
    (session) => session.Name !== nextSession.Name
  );
  sessions = [nextSession, ...remaining].sort(
    (left, right) => right.SortUnix - left.SortUnix
  );
}

function stopTranscriptPolling(): void {
  if (transcriptPollTimer !== null) {
    window.clearInterval(transcriptPollTimer);
    transcriptPollTimer = null;
  }
}

async function refreshTranscript(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }

  try {
    const transcript = await apiJson<SessionTranscript>(
      `/api/sessions/${encodeURIComponent(session.Name)}/output?lines=500`
    );
    const nearBottom =
      sessionTranscript.scrollHeight -
        sessionTranscript.scrollTop -
        sessionTranscript.clientHeight <
      40;
    if (transcript.Transcript !== lastTranscript) {
      sessionTranscript.textContent =
        transcript.Transcript || 'まだ出力はありません。';
      lastTranscript = transcript.Transcript;
      if (nearBottom) {
        sessionTranscript.scrollTop = sessionTranscript.scrollHeight;
      }
    }
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function startTranscriptPolling(): void {
  stopTranscriptPolling();
  void refreshTranscript();
  transcriptPollTimer = window.setInterval(
    () => void refreshTranscript(),
    1500
  );
}

function renderSelectedSession(): void {
  const session = getSelectedSession();
  if (!session) {
    selectedSessionState.textContent = '未選択';
    selectedSessionSummary.className = 'empty-state';
    selectedSessionSummary.textContent =
      '左側の一覧から session を選ぶと、ここに出力と操作が出ます。';
    selectedSessionControls.style.display = 'none';
    sessionTranscript.textContent = '';
    lastTranscript = '';
    stopTranscriptPolling();
    return;
  }

  selectedSessionState.textContent = `${session.Type.toUpperCase()} / ${session.IsLive ? 'Running' : 'Closed'}`;
  selectedSessionSummary.className = 'pill-row';
  selectedSessionSummary.innerHTML = '';
  selectedSessionSummary.appendChild(
    makeBadge(
      session.IsLive ? 'live' : 'closed',
      session.IsLive ? '動作中' : '停止済み'
    )
  );
  if (session.Archived) {
    selectedSessionSummary.appendChild(makeBadge('archived', '一覧では非表示'));
  }

  const folder = document.createElement('span');
  folder.className = 'pill';
  folder.textContent = session.WorkingDirectoryWindows || config.workspaceRoot;

  const preview = document.createElement('span');
  preview.className = 'pill';
  preview.textContent = session.PreviewText || '最新プレビューなし';

  selectedSessionSummary.append(folder, preview);
  selectedSessionControls.style.display = 'block';
  archiveSessionButton.textContent = session.Archived
    ? '一覧へ戻す'
    : '一覧から隠す';
  sendPromptButton.disabled = !session.IsLive;
  sendRawButton.disabled = !session.IsLive;
  interruptSessionButton.disabled = !session.IsLive;
  startTranscriptPolling();
}

async function refreshSessions(): Promise<void> {
  if (isRefreshPaused()) {
    return;
  }
  try {
    sessions = await apiJson<SessionRecord[]>(
      '/api/sessions?includeArchived=true'
    );
    renderSessions(sessions);
    renderSelectedSession();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function loadDirectorySuggestions(): Promise<void> {
  try {
    const suggestions =
      await apiJson<DirectorySuggestion[]>('/api/directories');
    workingDirectorySuggestions.innerHTML = '';
    for (const suggestion of suggestions) {
      const option = document.createElement('option');
      option.value = suggestion.path;
      option.label = suggestion.label;
      workingDirectorySuggestions.appendChild(option);
    }
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function startSession(): Promise<void> {
  setBusy(startSessionButton, true, '開始中...');
  try {
    const session = await withRefreshPause(() =>
      apiJson<SessionRecord>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: sessionTypeSelect.value,
          title: sessionTitleInput.value,
          workingDirectory: workingDirectoryInput.value,
        }),
      })
    );
    upsertSession(session);
    selectedSessionName = session.Name;
    sessionPromptInput.value = '';
    renderSessions(sessions);
    renderSelectedSession();
    showToast('新しい session を開始しました。');
    void refreshSessions();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(startSessionButton, false, '');
  }
}

async function sendPrompt(submit: boolean): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    showToast('先に session を選んでください。');
    return;
  }
  const text = sessionPromptInput.value.trim();
  if (!text) {
    showToast('送る内容を入力してください。');
    return;
  }

  const targetButton = submit ? sendPromptButton : sendRawButton;
  setBusy(targetButton, true, submit ? '送信中...' : '貼り付け中...');
  try {
    await withRefreshPause(() =>
      apiJson(`/api/sessions/${encodeURIComponent(session.Name)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, submit }),
      })
    );
    sessionPromptInput.value = '';
    await refreshTranscript();
    void refreshSessions();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(targetButton, false, '');
  }
}

async function renameSelectedSession(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  const nextTitle = window.prompt(
    '新しいタイトルを入力してください。',
    session.DisplayTitle
  );
  if (!nextTitle || !nextTitle.trim()) {
    return;
  }
  try {
    const updated = await withRefreshPause(() =>
      apiJson<SessionRecord>(
        `/api/sessions/${encodeURIComponent(session.Name)}/rename`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle.trim() }),
        }
      )
    );
    upsertSession(updated);
    renderSessions(sessions);
    renderSelectedSession();
    void refreshSessions();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function archiveSelectedSession(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  const route = session.Archived ? 'unarchive' : 'archive';
  try {
    const updated = await withRefreshPause(() =>
      apiJson<SessionRecord>(
        `/api/sessions/${encodeURIComponent(session.Name)}/${route}`,
        { method: 'POST' }
      )
    );
    upsertSession(updated);
    renderSessions(sessions);
    renderSelectedSession();
    void refreshSessions();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function interruptSelectedSession(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  try {
    await withRefreshPause(() =>
      apiJson(`/api/sessions/${encodeURIComponent(session.Name)}/interrupt`, {
        method: 'POST',
      })
    );
    showToast('Ctrl+C を送信しました。');
    await refreshTranscript();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function closeSelectedSession(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  try {
    const updated = await withRefreshPause(() =>
      apiJson<SessionRecord>(
        `/api/sessions/${encodeURIComponent(session.Name)}/close`,
        {
          method: 'POST',
        }
      )
    );
    upsertSession(updated);
    renderSessions(sessions);
    renderSelectedSession();
    void refreshSessions();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function deleteSelectedSession(): Promise<void> {
  const session = getSelectedSession();
  if (!session) {
    return;
  }
  if (!window.confirm('この session を完全に削除します。よろしいですか？')) {
    return;
  }
  try {
    await withRefreshPause(() =>
      apiJson(`/api/sessions/${encodeURIComponent(session.Name)}`, {
        method: 'DELETE',
      })
    );
    sessions = sessions.filter((item) => item.Name !== session.Name);
    selectedSessionName = '';
    renderSessions(sessions);
    renderSelectedSession();
    void refreshSessions();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

connectionHint.textContent = window.isSecureContext
  ? 'Secure context'
  : 'Use Tailscale Serve for installable mode';
workingDirectoryInput.value = config.workspaceRoot;

refreshSessionsButton.addEventListener('click', () => void refreshSessions());
startSessionButton.addEventListener('click', () => void startSession());
showArchivedButton.addEventListener('click', () => {
  includeArchived = !includeArchived;
  showArchivedButton.textContent = includeArchived
    ? '動作中だけ表示'
    : '閉じた session も表示';
  renderSessions(sessions);
  renderSelectedSession();
});
sendPromptButton.addEventListener('click', () => void sendPrompt(true));
sendRawButton.addEventListener('click', () => void sendPrompt(false));
renameSessionButton.addEventListener(
  'click',
  () => void renameSelectedSession()
);
archiveSessionButton.addEventListener(
  'click',
  () => void archiveSelectedSession()
);
interruptSessionButton.addEventListener(
  'click',
  () => void interruptSelectedSession()
);
closeSessionButton.addEventListener('click', () => void closeSelectedSession());
deleteSessionButton.addEventListener(
  'click',
  () => void deleteSelectedSession()
);

authSubmitButton.addEventListener('click', async () => {
  const nextToken = authTokenInput.value.trim();
  if (!nextToken) {
    return;
  }
  authToken = nextToken;
  writeStoredAuthToken(nextToken);
  setAuthOverlayVisible(false);
  await refreshSessions();
  await loadDirectorySuggestions();
});

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refreshSessions();
    if (selectedSessionName) {
      void refreshTranscript();
    }
  }
});

window.addEventListener('beforeunload', () => {
  stopTranscriptPolling();
  if (sessionPollTimer !== null) {
    window.clearInterval(sessionPollTimer);
    sessionPollTimer = null;
  }
});

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js');
}

if (config.authRequired && !authToken) {
  setAuthOverlayVisible(true);
} else {
  setAuthOverlayVisible(false);
}

void loadDirectorySuggestions();
void refreshSessions();
sessionPollTimer = window.setInterval(() => void refreshSessions(), 2500);
