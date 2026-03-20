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

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{
      outcome: 'accepted' | 'dismissed';
      platform: string;
    }>;
  }
}

const config = window.WORKSPACE_AGENT_HUB_CONFIG;
const authStorageKey = config.authStorageKey;
const sessionsCacheKey = `${authStorageKey}.sessions`;
const notificationsPreferenceKey = `${authStorageKey}.notifications-enabled`;
const favoriteSessionsKey = `${authStorageKey}.favorite-sessions`;
const lastSessionNameKey = `${authStorageKey}.last-session-name`;
const sessionDraftsKey = `${authStorageKey}.session-drafts`;
const sessionSeenActivityKey = `${authStorageKey}.session-seen-activity`;
const appShell = document.querySelector<HTMLDivElement>('.shell')!;

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
const lastSessionCard =
  document.querySelector<HTMLDivElement>('#lastSessionCard')!;
const lastSessionTitle =
  document.querySelector<HTMLSpanElement>('#lastSessionTitle')!;
const lastSessionMeta =
  document.querySelector<HTMLDivElement>('#lastSessionMeta')!;
const openLastSessionButton = document.querySelector<HTMLButtonElement>(
  '#openLastSessionButton'
)!;
const showArchivedButton = document.querySelector<HTMLButtonElement>(
  '#showArchivedButton'
)!;
const sessionSearchInput = document.querySelector<HTMLInputElement>(
  '#sessionSearchInput'
)!;
const favoriteSessionsOnlyButton = document.querySelector<HTMLButtonElement>(
  '#favoriteSessionsOnlyButton'
)!;
const sessionsListHint =
  document.querySelector<HTMLSpanElement>('#sessionsListHint')!;
const selectedSessionState = document.querySelector<HTMLSpanElement>(
  '#selectedSessionState'
)!;
const selectedSessionSummary = document.querySelector<HTMLDivElement>(
  '#selectedSessionSummary'
)!;
const selectedSessionControls = document.querySelector<HTMLDivElement>(
  '#selectedSessionControls'
)!;
const promptComposerShell = document.querySelector<HTMLDivElement>(
  '#promptComposerShell'
)!;
const sessionPromptLead =
  document.querySelector<HTMLSpanElement>('#sessionPromptLead')!;
const sessionPromptHint =
  document.querySelector<HTMLSpanElement>('#sessionPromptHint')!;
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
const connectivityBanner = document.querySelector<HTMLDivElement>(
  '#connectivityBanner'
)!;
const installHint =
  document.querySelector<HTMLParagraphElement>('#installHint')!;
const installAppButton =
  document.querySelector<HTMLButtonElement>('#installAppButton')!;
const installStatus =
  document.querySelector<HTMLSpanElement>('#installStatus')!;
const notificationHint =
  document.querySelector<HTMLParagraphElement>('#notificationHint')!;
const enableNotificationsButton = document.querySelector<HTMLButtonElement>(
  '#enableNotificationsButton'
)!;
const notificationStatus = document.querySelector<HTMLSpanElement>(
  '#notificationStatus'
)!;
const lockDeviceButton =
  document.querySelector<HTMLButtonElement>('#lockDeviceButton')!;
const pairingHint =
  document.querySelector<HTMLParagraphElement>('#pairingHint')!;
const pairingUrlInput =
  document.querySelector<HTMLInputElement>('#pairingUrlInput')!;
const sharePairingButton = document.querySelector<HTMLButtonElement>(
  '#sharePairingButton'
)!;
const copyPairingLinkButton = document.querySelector<HTMLButtonElement>(
  '#copyPairingLinkButton'
)!;
const copyManualUrlButton = document.querySelector<HTMLButtonElement>(
  '#copyManualUrlButton'
)!;
const pairingCodeInput =
  document.querySelector<HTMLInputElement>('#pairingCodeInput')!;
const copyPairingCodeButton = document.querySelector<HTMLButtonElement>(
  '#copyPairingCodeButton'
)!;
const pairingQrImage =
  document.querySelector<HTMLImageElement>('#pairingQrImage')!;
const pairingQrStatus =
  document.querySelector<HTMLSpanElement>('#pairingQrStatus')!;
const secureLaunchShell =
  document.querySelector<HTMLDivElement>('#secureLaunchShell')!;
const secureLaunchCommandInput = document.querySelector<HTMLInputElement>(
  '#secureLaunchCommandInput'
)!;
const openSecureLaunchSetupButton = document.querySelector<HTMLButtonElement>(
  '#openSecureLaunchSetupButton'
)!;
const copySecureLaunchCommandButton = document.querySelector<HTMLButtonElement>(
  '#copySecureLaunchCommandButton'
)!;
const secureLaunchStatus = document.querySelector<HTMLSpanElement>(
  '#secureLaunchStatus'
)!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const authOverlay = document.querySelector<HTMLDivElement>('#authOverlay')!;
const authTokenInput =
  document.querySelector<HTMLInputElement>('#authTokenInput')!;
const authSubmitButton =
  document.querySelector<HTMLButtonElement>('#authSubmitButton')!;
const openManagerButton =
  document.querySelector<HTMLButtonElement>('#openManagerButton')!;
const managerStatus =
  document.querySelector<HTMLSpanElement>('#managerStatus')!;

const sessionRows = new Map<string, HTMLDivElement>();

let sessions: SessionRecord[] = [];
let selectedSessionName = '';
let includeArchived = false;
let showFavoriteSessionsOnly = false;
let transcriptPollTimer: number | null = null;
let sessionPollTimer: number | null = null;
let lastTranscript = '';
let favoriteSessionNames = new Set(
  readStoredJson<string[]>(favoriteSessionsKey) ?? []
);
let promptDraftBySession = new Map(
  Object.entries(readStoredJson<Record<string, string>>(sessionDraftsKey) ?? {})
);
let seenActivityBySession = new Map(
  Object.entries(
    readStoredJson<Record<string, number>>(sessionSeenActivityKey) ?? {}
  ).map(([sessionName, seenUnix]) => [sessionName, Number(seenUnix) || 0])
);
let authToken = readStoredAuthToken();
let notificationsEnabled =
  readStoredJson<boolean>(notificationsPreferenceKey) ?? false;
let refreshPauseDepth = 0;
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let connectionState: 'connecting' | 'online' | 'offline' | 'auth' =
  'connecting';
const lastNotifiedTranscriptBySession = new Map<string, string>();
let pairingQrLink = '';
let promptAttentionTimer: number | null = null;

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

function readStoredText(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function writeStoredText(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function removeStoredValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readStoredJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function persistPromptDrafts(): void {
  const trimmedDrafts = [...promptDraftBySession.entries()].filter(
    ([, draft]) => draft.trim().length > 0
  );
  promptDraftBySession = new Map(trimmedDrafts);
  writeStoredJson(sessionDraftsKey, Object.fromEntries(trimmedDrafts));
}

function persistSeenActivity(): void {
  writeStoredJson(
    sessionSeenActivityKey,
    Object.fromEntries(seenActivityBySession.entries())
  );
}

function getSavedDraft(sessionName: string): string {
  return promptDraftBySession.get(sessionName) ?? '';
}

function sessionHasSavedDraft(sessionName: string): boolean {
  return getSavedDraft(sessionName).trim().length > 0;
}

function persistCurrentPromptDraft(): void {
  if (!selectedSessionName) {
    return;
  }
  const draft = sessionPromptInput.value;
  if (draft.trim()) {
    promptDraftBySession.set(selectedSessionName, draft);
  } else {
    promptDraftBySession.delete(selectedSessionName);
  }
  persistPromptDrafts();

  const session = sessions.find((item) => item.Name === selectedSessionName);
  const sessionRow = session ? sessionRows.get(session.Name) : null;
  if (session && sessionRow) {
    patchSessionCard(sessionRow, session);
  }
}

function clearPromptDraft(sessionName: string): void {
  promptDraftBySession.delete(sessionName);
  persistPromptDrafts();
  const session = sessions.find((item) => item.Name === sessionName);
  const sessionRow = session ? sessionRows.get(session.Name) : null;
  if (session && sessionRow) {
    patchSessionCard(sessionRow, session);
  }
  if (sessionName === selectedSessionName) {
    renderSelectedSession();
  }
}

function getRememberedSessionName(): string {
  return readStoredText(lastSessionNameKey) ?? '';
}

function rememberSession(sessionName: string): void {
  writeStoredText(lastSessionNameKey, sessionName);
}

function clearRememberedSession(sessionName?: string): void {
  const rememberedSessionName = getRememberedSessionName();
  if (!rememberedSessionName) {
    return;
  }
  if (!sessionName || rememberedSessionName === sessionName) {
    removeStoredValue(lastSessionNameKey);
  }
}

function getTranscriptCacheKey(sessionName: string): string {
  return `${authStorageKey}.transcript.${sessionName}`;
}

function isCompactLayout(): boolean {
  return (
    window.matchMedia('(max-width: 920px)').matches || window.innerWidth <= 920
  );
}

function spotlightPromptComposer(options?: {
  focusInput?: boolean;
  scrollIntoView?: boolean;
}): void {
  if (promptAttentionTimer !== null) {
    window.clearTimeout(promptAttentionTimer);
    promptAttentionTimer = null;
  }

  promptComposerShell.classList.remove('attention');
  void promptComposerShell.offsetWidth;
  promptComposerShell.classList.add('attention');

  if (options?.scrollIntoView || isCompactLayout()) {
    promptComposerShell.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  if (options?.focusInput) {
    window.setTimeout(() => {
      sessionPromptInput.focus();
      const end = sessionPromptInput.value.length;
      sessionPromptInput.setSelectionRange(end, end);
    }, 0);
  }

  promptAttentionTimer = window.setTimeout(() => {
    promptComposerShell.classList.remove('attention');
    promptAttentionTimer = null;
  }, 1800);
}

function isFavoriteSession(sessionName: string): boolean {
  return favoriteSessionNames.has(sessionName);
}

function persistFavoriteSessions(): void {
  writeStoredJson(favoriteSessionsKey, [...favoriteSessionNames]);
}

function toggleFavoriteSession(sessionName: string): void {
  if (favoriteSessionNames.has(sessionName)) {
    favoriteSessionNames.delete(sessionName);
  } else {
    favoriteSessionNames.add(sessionName);
  }
  persistFavoriteSessions();
  renderSessions(sessions);
  renderSelectedSession();
}

function getCurrentPageUrl(): string {
  const currentUrl = new URL(window.location.href);
  currentUrl.hash = '';
  return currentUrl.toString();
}

function getPairingBaseUrl(): string {
  return config.preferredConnectUrl || getCurrentPageUrl();
}

function getPairingCode(): string {
  return config.authRequired ? (authToken ?? '') : '';
}

function getOneTapPairingLink(): string {
  const baseUrl = getPairingBaseUrl();
  const accessCode = getPairingCode();
  if (!config.authRequired) {
    return baseUrl;
  }
  if (!accessCode) {
    return '';
  }
  return `${baseUrl}#accessCode=${encodeURIComponent(accessCode)}`;
}

function isPhoneReachablePairingUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return !/^(127\.0\.0\.1|localhost|0\.0\.0\.0|::1|::)$/i.test(hostname);
  } catch {
    return false;
  }
}

function canSharePairingDetails(): boolean {
  return typeof navigator.share === 'function';
}

function hasAccessToken(): boolean {
  return !config.authRequired || Boolean(authToken);
}

function notificationsAreSupported(): boolean {
  return typeof window.Notification !== 'undefined';
}

function setNotificationsEnabled(value: boolean): void {
  notificationsEnabled = value;
  writeStoredJson(notificationsPreferenceKey, value);
}

function getLatestTranscriptSnippet(transcript: string): string {
  const lines = transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '新しい出力があります。';
}

function applyAccessCodeFromLocationHash(): boolean {
  const currentUrl = new URL(window.location.href);
  const accessCode = new URLSearchParams(currentUrl.hash.replace(/^#/, '')).get(
    'accessCode'
  );
  if (!accessCode) {
    return false;
  }
  authToken = accessCode;
  writeStoredAuthToken(accessCode);
  currentUrl.hash = '';
  window.history.replaceState({}, document.title, currentUrl.toString());
  return true;
}

function isInstalledPwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

function setConnectionState(
  state: 'connecting' | 'online' | 'offline' | 'auth',
  detail: string
): void {
  connectionState = state;
  connectivityBanner.classList.remove('ok', 'warn', 'offline');

  if (state === 'online') {
    connectionHint.textContent = '接続中';
    connectivityBanner.classList.add('ok');
    connectivityBanner.innerHTML = `<strong>接続中</strong><p>${detail}</p>`;
    return;
  }

  if (state === 'offline') {
    connectionHint.textContent = 'オフライン';
    connectivityBanner.classList.add('offline');
    connectivityBanner.innerHTML = `<strong>オフラインでも継続表示</strong><p>${detail}</p>`;
    return;
  }

  if (state === 'auth') {
    connectionHint.textContent = 'コード待ち';
    connectivityBanner.classList.add('warn');
    connectivityBanner.innerHTML = `<strong>アクセスコード待ち</strong><p>${detail}</p>`;
    return;
  }

  connectionHint.textContent = '接続確認中';
  connectivityBanner.classList.add('warn');
  connectivityBanner.innerHTML = `<strong>接続状態を確認中</strong><p>${detail}</p>`;
}

function setInstallUiState(): void {
  if (isInstalledPwa()) {
    installAppButton.hidden = true;
    installAppButton.disabled = true;
    installHint.textContent =
      'この端末では、すでにホーム画面アプリとして開いています。PC ではデスクトップかスタートメニューの Workspace Agent Hub から開けます。';
    installStatus.textContent = 'インストール済みです。';
    return;
  }

  if (!window.isSecureContext) {
    installAppButton.hidden = true;
    installAppButton.disabled = true;
    installHint.textContent =
      'HTTPS で開くとホーム画面アプリとして追加できます。Tailscale Serve などの secure context を使ってください。PC ではデスクトップかスタートメニューの Workspace Agent Hub から開けます。';
    installStatus.textContent = '現在は通常のブラウザ表示です。';
    return;
  }

  if (deferredInstallPrompt) {
    installAppButton.hidden = false;
    installAppButton.disabled = false;
    installHint.textContent =
      'この端末に追加できます。追加するとスマホから 1 タップで開けます。PC ではデスクトップかスタートメニューの Workspace Agent Hub から開けます。';
    installStatus.textContent = 'インストール可能です。';
    return;
  }

  installAppButton.hidden = true;
  installAppButton.disabled = true;
  installHint.textContent =
    'このブラウザでは追加ボタンがまだ利用できません。共有メニューの「ホーム画面に追加」でも構いません。PC ではデスクトップかスタートメニューの Workspace Agent Hub から開けます。';
  installStatus.textContent = 'ブラウザ側の準備待ちです。';
}

function setNotificationUiState(): void {
  if (!notificationsAreSupported()) {
    notificationsEnabled = false;
    enableNotificationsButton.hidden = true;
    enableNotificationsButton.disabled = true;
    notificationHint.textContent =
      'このブラウザでは通知 API が利用できません。';
    notificationStatus.textContent = '通知は未対応です。';
    return;
  }

  enableNotificationsButton.hidden = false;

  if (window.Notification.permission === 'granted') {
    enableNotificationsButton.disabled = false;
    enableNotificationsButton.textContent = notificationsEnabled
      ? '通知を無効にする'
      : '通知を有効にする';
    notificationHint.textContent = notificationsEnabled
      ? '選択中 session の新しい出力を、画面が非表示のときに通知します。'
      : '通知権限はあります。必要ならこのページで通知を有効にできます。';
    notificationStatus.textContent = notificationsEnabled
      ? '通知は有効です。'
      : '通知権限あり、現在は停止中です。';
    return;
  }

  if (window.Notification.permission === 'denied') {
    notificationsEnabled = false;
    enableNotificationsButton.disabled = true;
    enableNotificationsButton.textContent = '通知を有効にする';
    notificationHint.textContent =
      '通知がブラウザ側で拒否されています。ブラウザ設定から許可すると使えます。';
    notificationStatus.textContent = '通知は拒否されています。';
    return;
  }

  enableNotificationsButton.disabled = false;
  enableNotificationsButton.textContent = '通知を有効にする';
  notificationHint.textContent =
    '通知を許可すると、画面を閉じていても選択中 session の更新に気づけます。';
  notificationStatus.textContent = '通知は未設定です。';
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function shouldHideQrForAuth(): boolean {
  return (
    config.authRequired && (!hasAccessToken() || connectionState === 'auth')
  );
}

async function updatePairingQr(link: string): Promise<void> {
  pairingQrLink = link;
  if (shouldHideQrForAuth()) {
    pairingQrImage.hidden = true;
    pairingQrImage.removeAttribute('src');
    pairingQrStatus.textContent =
      'アクセスコードを受け付けると QR を表示します。';
    return;
  }
  if (!isPhoneReachablePairingUrl(link)) {
    pairingQrImage.hidden = true;
    pairingQrImage.removeAttribute('src');
    pairingQrStatus.textContent =
      'この起動ではスマホ用 QR をまだ出せません。-PhoneReady か --public-url でスマホ向け URL を用意してください。';
    return;
  }

  try {
    const pairingQr = await apiJson<{ connectUrl: string; dataUrl: string }>(
      '/api/pairing-qr'
    );
    if (pairingQrLink !== link || shouldHideQrForAuth()) {
      return;
    }
    pairingQrImage.src = pairingQr.dataUrl;
    pairingQrImage.hidden = false;
    pairingQrStatus.textContent = 'スマホではまずこれを読み取ってください。';
  } catch {
    pairingQrImage.hidden = true;
    pairingQrImage.removeAttribute('src');
    pairingQrStatus.textContent =
      'QR の生成に失敗しました。リンクをコピーしてください。';
  }
}

function setPairingUiState(): void {
  const baseUrl = getPairingBaseUrl();
  const oneTapLink = getOneTapPairingLink();
  const accessCode = getPairingCode();
  const preferredConnectSource = config.preferredConnectUrlSource;
  const tailscaleFallbackReason =
    config.tailscaleServeFallbackReason?.trim() || '';

  pairingUrlInput.value = oneTapLink;
  pairingCodeInput.value = accessCode || '不要';

  if (preferredConnectSource === 'tailscale-serve') {
    pairingHint.textContent =
      'まずこの QR をスマホで読み取ってください。Tailscale Serve で HTTPS 化されているので、そのまま開き、ホーム画面にも追加しやすい経路です。';
  } else if (preferredConnectSource === 'public-url') {
    pairingHint.textContent =
      'まずこの QR をスマホで読み取ってください。共有やリンク貼り付けは、QR が使えないときだけで十分です。';
  } else if (preferredConnectSource === 'tailscale-direct') {
    pairingHint.textContent =
      'まずこの QR をスマホで読み取ってください。Tailscale 直結でそのまま開けます。HTTPS ではないので、ホーム画面追加まで欲しいときは下の HTTPS 化コマンドが有効です。';
  } else if (
    /^(127\.0\.0\.1|localhost|0\.0\.0\.0)$/i.test(new URL(baseUrl).hostname)
  ) {
    pairingHint.textContent =
      'いま見えている URL はこの PC 向けです。スマホで開くには -PhoneReady か --public-url でスマホ向け URL を用意してください。';
  } else {
    pairingHint.textContent =
      'まずこの QR をスマホで読み取ってください。リンク共有は QR が使えないときの予備です。';
  }

  sharePairingButton.textContent = canSharePairingDetails()
    ? '共有する'
    : '共有文をコピー';
  sharePairingButton.disabled = !oneTapLink && !baseUrl;
  copyPairingLinkButton.disabled = !oneTapLink;
  copyManualUrlButton.disabled = !baseUrl;
  copyPairingCodeButton.disabled = !config.authRequired || !accessCode;
  secureLaunchCommandInput.value = config.tailscaleServeCommand ?? '';
  secureLaunchShell.hidden =
    (!config.tailscaleServeCommand &&
      !config.tailscaleServeSetupUrl &&
      !tailscaleFallbackReason) ||
    preferredConnectSource === 'tailscale-serve' ||
    preferredConnectSource === 'public-url';
  openSecureLaunchSetupButton.hidden = !config.tailscaleServeSetupUrl;
  copySecureLaunchCommandButton.disabled = !config.tailscaleServeCommand;

  if (preferredConnectSource === 'tailscale-serve') {
    secureLaunchStatus.textContent =
      'この起動では Tailscale Serve を使っているため、スマホ向け HTTPS 導線はすでに準備できています。';
  } else if (config.tailscaleServeSetupUrl && config.tailscaleSecureUrl) {
    secureLaunchStatus.textContent = `まず Tailscale の DNS 設定ページで HTTPS Certificates を 1 回だけ有効にしてください。完了後、同じ -PhoneReady 起動をやり直すと ${config.tailscaleSecureUrl} を使えます。`;
  } else if (config.tailscaleServeSetupUrl) {
    secureLaunchStatus.textContent =
      'まず Tailscale の DNS 設定ページで HTTPS Certificates を 1 回だけ有効にしてください。完了後、同じ -PhoneReady 起動をやり直してください。';
  } else if (
    preferredConnectSource === 'tailscale-direct' &&
    tailscaleFallbackReason
  ) {
    secureLaunchStatus.textContent =
      'この起動では HTTPS 側を確認しましたが、まだ使えません。いまは QR の Tailscale 直結 URL を使ってください。' +
      ` 詳細: ${tailscaleFallbackReason}`;
  } else if (config.tailscaleServeCommand && config.tailscaleSecureUrl) {
    secureLaunchStatus.textContent = `より良い HTTPS 導線が必要なら、このコマンドで ${config.tailscaleSecureUrl} を有効にできます。`;
  } else if (config.tailscaleServeCommand) {
    secureLaunchStatus.textContent =
      '必要なときだけ、このコマンドで Tailscale Serve を有効にできます。';
  } else {
    secureLaunchStatus.textContent =
      '必要なときだけ、このコマンドで Tailscale Serve を有効にできます。';
  }
  void updatePairingQr(oneTapLink);
}

function buildPairingShareText(): {
  title: string;
  text: string;
  url?: string;
} {
  const baseUrl = getPairingBaseUrl();
  const oneTapLink = getOneTapPairingLink();
  const accessCode = getPairingCode();
  const lines = ['Workspace Agent Hub'];
  lines.push(`接続先: ${oneTapLink || baseUrl}`);
  if (config.authRequired && accessCode) {
    lines.push(`アクセスコード: ${accessCode}`);
  }
  return {
    title: 'Workspace Agent Hub',
    text: lines.join('\n'),
    url: oneTapLink || baseUrl,
  };
}

async function sharePairingDetails(): Promise<void> {
  const sharePayload = buildPairingShareText();
  if (canSharePairingDetails()) {
    try {
      await navigator.share(sharePayload);
      showToast('接続情報を共有しました。');
      return;
    } catch {
      /* fall back to clipboard below */
    }
  }

  const copied = await copyText(sharePayload.text);
  showToast(
    copied
      ? '接続情報をまとめてコピーしました。'
      : '接続情報をコピーできませんでした。'
  );
}

function maybeNotifyTranscript(
  session: SessionRecord,
  transcript: string
): void {
  if (
    !notificationsEnabled ||
    !notificationsAreSupported() ||
    window.Notification.permission !== 'granted' ||
    document.visibilityState === 'visible'
  ) {
    return;
  }

  const snippet = getLatestTranscriptSnippet(transcript);
  if (lastNotifiedTranscriptBySession.get(session.Name) === snippet) {
    return;
  }
  lastNotifiedTranscriptBySession.set(session.Name, snippet);

  const notification = new window.Notification(session.DisplayTitle, {
    body: snippet,
    tag: `workspace-agent-hub:${session.Name}`,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

function clearStoredSessionArtifacts(): void {
  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) {
        continue;
      }
      if (key === authStorageKey || key.startsWith(`${authStorageKey}.`)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

function lockCurrentDevice(): void {
  authToken = null;
  setNotificationsEnabled(false);
  clearStoredSessionArtifacts();
  sessions = [];
  selectedSessionName = '';
  lastTranscript = '';
  sessionTranscript.textContent = '';
  sessionPromptInput.value = '';
  promptDraftBySession = new Map();
  seenActivityBySession = new Map();
  lastNotifiedTranscriptBySession.clear();
  renderSessions(sessions);
  renderSelectedSession();
  setNotificationUiState();
  setAuthOverlayVisible(true);
  setPairingUiState();
  showToast('この端末に保存していたコードとキャッシュを消しました。');
}

async function toggleNotifications(): Promise<void> {
  if (!notificationsAreSupported()) {
    setNotificationUiState();
    return;
  }

  if (window.Notification.permission === 'granted') {
    setNotificationsEnabled(!notificationsEnabled);
    setNotificationUiState();
    showToast(
      notificationsEnabled ? '通知を有効にしました。' : '通知を無効にしました。'
    );
    return;
  }

  const permission = await window.Notification.requestPermission();
  if (permission === 'granted') {
    setNotificationsEnabled(true);
    showToast('通知を有効にしました。');
  } else if (permission === 'denied') {
    setNotificationsEnabled(false);
    showToast('通知はブラウザで拒否されました。');
  } else {
    setNotificationsEnabled(false);
    showToast('通知は保留のままです。');
  }
  setNotificationUiState();
}

function primeCachedSessions(): void {
  const cachedSessions = readStoredJson<SessionRecord[]>(sessionsCacheKey);
  if (!cachedSessions || cachedSessions.length === 0) {
    return;
  }

  sessions = cachedSessions;
  restorePreferredSelection();
  renderSessions(sessions);
  renderSelectedSession();
  setConnectionState(
    'offline',
    '最後に保存した session 一覧を表示しています。通信が戻ると自動で同期します。'
  );
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
  document.documentElement.classList.toggle('auth-locked', visible);
  document.body.classList.toggle('auth-locked', visible);
  appShell.setAttribute('aria-hidden', visible ? 'true' : 'false');
  (appShell as HTMLElement & { inert?: boolean }).inert = visible;
  if (visible) {
    setConnectionState(
      'auth',
      'アクセスコードを入力すると、session 一覧と transcript を同期できます。'
    );
  } else if (connectionState === 'auth') {
    setConnectionState(
      'connecting',
      'アクセスコードを受け付けました。session 一覧を同期しています。'
    );
  }
  if (visible) {
    authTokenInput.focus();
  }
  setPairingUiState();
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

function sessionMatchesSearch(session: SessionRecord): boolean {
  const query = sessionSearchInput.value.trim().toLocaleLowerCase('ja-JP');
  if (!query) {
    return true;
  }

  const haystack = [
    session.DisplayTitle,
    session.PreviewText,
    session.WorkingDirectoryWindows,
    session.Type,
    session.LastActivityLocal,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('ja-JP');
  return haystack.includes(query);
}

function getSelectedSession(): SessionRecord | undefined {
  return sessions.find((session) => session.Name === selectedSessionName);
}

function getRememberedSession(): SessionRecord | undefined {
  const rememberedSessionName = getRememberedSessionName();
  if (!rememberedSessionName) {
    return undefined;
  }
  return sessions.find((session) => session.Name === rememberedSessionName);
}

function sessionHasUnseenActivity(session: SessionRecord): boolean {
  const lastSeenUnix = seenActivityBySession.get(session.Name) ?? 0;
  return (
    session.Name !== selectedSessionName &&
    session.LastActivityUnix > lastSeenUnix
  );
}

function markSessionSeen(session: SessionRecord): void {
  const lastSeenUnix = seenActivityBySession.get(session.Name) ?? 0;
  if (session.LastActivityUnix <= lastSeenUnix) {
    return;
  }
  seenActivityBySession.set(session.Name, session.LastActivityUnix);
  persistSeenActivity();
  const existingCard = sessionRows.get(session.Name);
  if (existingCard) {
    patchSessionCard(existingCard, session);
  }
}

function renderLastSessionCard(): void {
  const rememberedSessionName = getRememberedSessionName();
  const rememberedSession = getRememberedSession();

  if (!rememberedSessionName || !rememberedSession) {
    lastSessionCard.hidden = true;
    lastSessionTitle.textContent = '前回の session';
    lastSessionMeta.textContent =
      'このブラウザで最後に開いていた session へ戻れます。';
    openLastSessionButton.disabled = true;
    return;
  }

  lastSessionCard.hidden = false;
  lastSessionTitle.textContent = rememberedSession.DisplayTitle;
  const statusLabel = rememberedSession.IsLive ? '動作中' : '停止済み';
  const hiddenLabel = rememberedSession.Archived ? ' / 一覧では非表示' : '';
  const draftLabel = sessionHasSavedDraft(rememberedSession.Name)
    ? ' / 下書きあり'
    : '';
  lastSessionMeta.textContent =
    `${rememberedSession.Type.toUpperCase()} / ${statusLabel}${hiddenLabel}${draftLabel}\n` +
    `${rememberedSession.WorkingDirectoryWindows || config.workspaceRoot}`;
  openLastSessionButton.disabled = false;
}

function selectSession(
  sessionName: string,
  options?: { revealPrompt?: boolean }
): void {
  if (selectedSessionName === sessionName) {
    if (options?.revealPrompt) {
      spotlightPromptComposer({ focusInput: true });
    }
    return;
  }
  persistCurrentPromptDraft();
  selectedSessionName = sessionName;
  rememberSession(sessionName);
  lastTranscript = '';
  sessionTranscript.textContent = '';
  sessionPromptInput.value = getSavedDraft(sessionName);
  const session = sessions.find((item) => item.Name === sessionName);
  if (session) {
    markSessionSeen(session);
  }
  renderSessions(sessions);
  renderSelectedSession();
  if (options?.revealPrompt) {
    spotlightPromptComposer({
      focusInput: Boolean(getSelectedSession()?.IsLive),
    });
  }
}

function restorePreferredSelection(): void {
  if (
    selectedSessionName &&
    sessions.some((session) => session.Name === selectedSessionName)
  ) {
    return;
  }
  const rememberedSession = getRememberedSession();
  if (rememberedSession) {
    selectedSessionName = rememberedSession.Name;
    sessionPromptInput.value = getSavedDraft(rememberedSession.Name);
  }
}

function openRememberedSession(): void {
  const rememberedSession = getRememberedSession();
  if (!rememberedSession) {
    showToast('前回の session が見つかりません。');
    return;
  }
  if (rememberedSession.Archived || !rememberedSession.IsLive) {
    includeArchived = true;
    showArchivedButton.textContent = '動作中だけ表示';
  }
  showFavoriteSessionsOnly = false;
  favoriteSessionsOnlyButton.textContent = 'お気に入りだけ表示';
  sessionSearchInput.value = '';
  if (selectedSessionName === rememberedSession.Name) {
    renderSessions(sessions);
    renderSelectedSession();
    spotlightPromptComposer({ focusInput: Boolean(rememberedSession.IsLive) });
    return;
  }
  selectSession(rememberedSession.Name, { revealPrompt: true });
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

function handleOfflineError(
  error: unknown,
  detail: string,
  toastMessage: string
): boolean {
  if (!window.navigator.onLine || error instanceof TypeError) {
    setConnectionState('offline', detail);
    showToast(toastMessage);
    return true;
  }
  return false;
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

  const headRow = document.createElement('div');
  headRow.className = 'session-head-row';

  const title = document.createElement('h3');
  title.className = 'session-title';
  title.textContent = session.DisplayTitle;

  const favoriteButton = document.createElement('button');
  favoriteButton.className = isFavoriteSession(session.Name)
    ? 'favorite-button active'
    : 'favorite-button';
  favoriteButton.type = 'button';
  favoriteButton.textContent = isFavoriteSession(session.Name) ? '★' : '☆';
  favoriteButton.setAttribute(
    'aria-label',
    isFavoriteSession(session.Name) ? 'お気に入りを外す' : 'お気に入りに固定'
  );
  favoriteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavoriteSession(session.Name);
  });
  headRow.append(title, favoriteButton);

  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';
  statusRow.appendChild(
    makeBadge(
      session.IsLive ? 'live' : 'closed',
      session.IsLive ? 'Running' : 'Closed'
    )
  );
  if (sessionHasUnseenActivity(session)) {
    statusRow.appendChild(makeBadge('unseen', '新しい出力'));
  }
  if (sessionHasSavedDraft(session.Name)) {
    statusRow.appendChild(makeBadge('draft', '下書きあり'));
  }
  if (isFavoriteSession(session.Name)) {
    statusRow.appendChild(makeBadge('live', 'お気に入り'));
  }
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

  card.append(headRow, statusRow, preview, folder, meta);
}

function renderSessions(nextSessions: SessionRecord[]): void {
  const selectedSessionStillExists = selectedSessionName
    ? nextSessions.some((session) => session.Name === selectedSessionName)
    : false;
  const visibleSessions = nextSessions
    .filter(sessionIsVisible)
    .filter((session) =>
      showFavoriteSessionsOnly ? isFavoriteSession(session.Name) : true
    )
    .filter(sessionMatchesSearch)
    .sort((left, right) => {
      const leftFavorite = isFavoriteSession(left.Name) ? 1 : 0;
      const rightFavorite = isFavoriteSession(right.Name) ? 1 : 0;
      if (leftFavorite !== rightFavorite) {
        return rightFavorite - leftFavorite;
      }
      return right.SortUnix - left.SortUnix;
    });
  sessionsList.innerHTML = '';
  favoriteSessionsOnlyButton.textContent = showFavoriteSessionsOnly
    ? 'すべて表示'
    : 'お気に入りだけ表示';

  const query = sessionSearchInput.value.trim();
  if (showFavoriteSessionsOnly && query) {
    sessionsListHint.textContent =
      'お気に入りの中から検索しています。最近動いたものが上です。';
  } else if (showFavoriteSessionsOnly) {
    sessionsListHint.textContent =
      'この端末で固定した session だけを表示しています。';
  } else if (query) {
    sessionsListHint.textContent =
      'タイトル・プレビュー・フォルダ・種類から絞り込んでいます。';
  } else {
    sessionsListHint.textContent = '最近動いた session が上に出ます。';
  }

  renderLastSessionCard();

  if (visibleSessions.length === 0) {
    const emptyState = showFavoriteSessionsOnly
      ? 'お気に入りにした session がありません。カード右上の星で固定できます。'
      : query
        ? '一致する session がありません。言葉を変えるか、お気に入り絞り込みを外してください。'
        : 'まだ session がありません。左上から新しい session を始めてください。';
    sessionsList.innerHTML = `<div class="empty-state">${emptyState}</div>`;
    if (selectedSessionName && !selectedSessionStillExists) {
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
        selectSession(session.Name, { revealPrompt: true });
      });
      sessionRows.set(session.Name, card);
    }
    patchSessionCard(card, session);
    sessionsList.appendChild(card);
  }

  if (selectedSessionName && !selectedSessionStillExists) {
    persistCurrentPromptDraft();
    selectedSessionName = '';
    lastTranscript = '';
    sessionTranscript.textContent = '';
    sessionPromptInput.value = '';
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

function showStoppedSessionTranscript(sessionName: string): void {
  const cachedTranscript = readStoredJson<string>(
    getTranscriptCacheKey(sessionName)
  );
  if (cachedTranscript) {
    sessionTranscript.textContent = cachedTranscript;
    lastTranscript = cachedTranscript;
    return;
  }

  if (!sessionTranscript.textContent.trim()) {
    sessionTranscript.textContent =
      'この session は停止済みです。保存済みの transcript がないため、ここには新しい出力を表示できません。';
  }
  lastTranscript = '';
}

function isMissingLiveSessionError(
  error: unknown,
  sessionName: string
): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes(sessionName) &&
    error.message.includes('Session') &&
    error.message.includes('not found')
  );
}

function markSessionStopped(sessionName: string): void {
  const session = sessions.find((item) => item.Name === sessionName);
  if (!session || !session.IsLive) {
    return;
  }

  session.IsLive = false;
  session.State = 'Saved';
}

async function refreshTranscript(): Promise<void> {
  const session = getSelectedSession();
  if (!session || !hasAccessToken()) {
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
      maybeNotifyTranscript(session, transcript.Transcript);
      sessionTranscript.textContent =
        transcript.Transcript || 'まだ出力はありません。';
      lastTranscript = transcript.Transcript;
      writeStoredJson(
        getTranscriptCacheKey(session.Name),
        transcript.Transcript
      );
      if (nearBottom) {
        sessionTranscript.scrollTop = sessionTranscript.scrollHeight;
      }
    }
    markSessionSeen(session);
    setConnectionState(
      'online',
      `session 出力を同期しました。最終取得 ${new Date().toLocaleTimeString('ja-JP')}`
    );
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    if (!window.navigator.onLine) {
      setConnectionState(
        'offline',
        'ネットワークが戻るまで、最後に取得した transcript を表示しています。'
      );
      return;
    }
    if (isMissingLiveSessionError(error, session.Name)) {
      stopTranscriptPolling();
      markSessionStopped(session.Name);
      renderSessions(sessions);
      renderSelectedSession();
      setConnectionState(
        'online',
        'session が停止したため、保存済み transcript の表示に切り替えました。'
      );
      void refreshSessions();
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
    selectedSessionState.textContent = '← 左で session を選ぶ';
    selectedSessionSummary.className = 'empty-state';
    selectedSessionSummary.textContent =
      'まず左で新しい作業を始めるか、続きから開く session を選びます。選んだあと、この下の入力欄から AI に続きの指示を送れます。';
    selectedSessionControls.style.display = 'block';
    sessionTranscript.textContent =
      '選んだ session の出力がここに出ます。下の入力欄は、session を選ぶと使えるようになります。';
    lastTranscript = '';
    sessionPromptLead.textContent =
      '次は session を選んでから、ここに一言ずつ書きます';
    sessionPromptHint.textContent =
      '先に左の一覧から session を選ぶと、ここがすぐ使える状態になります。';
    sessionPromptInput.value = '';
    sessionPromptInput.disabled = true;
    sessionPromptInput.placeholder =
      '先に左の一覧から session を選ぶと、ここから AI に送れます。';
    renameSessionButton.disabled = true;
    archiveSessionButton.disabled = true;
    interruptSessionButton.disabled = true;
    closeSessionButton.disabled = true;
    deleteSessionButton.disabled = true;
    sendPromptButton.disabled = true;
    sendRawButton.disabled = true;
    stopTranscriptPolling();
    return;
  }

  selectedSessionState.textContent = `${session.Type.toUpperCase()} / ${session.IsLive ? '動作中' : '停止済み'}`;
  selectedSessionSummary.className = 'pill-row';
  selectedSessionSummary.innerHTML = '';
  selectedSessionSummary.appendChild(
    makeBadge(
      session.IsLive ? 'live' : 'closed',
      session.IsLive ? '動作中' : '停止済み'
    )
  );
  if (isFavoriteSession(session.Name)) {
    selectedSessionSummary.appendChild(makeBadge('live', 'お気に入り'));
  }
  if (sessionHasSavedDraft(session.Name)) {
    selectedSessionSummary.appendChild(makeBadge('draft', '下書きあり'));
  }
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
  sessionPromptLead.textContent = '次はここに一言ずつ書いて AI に送ります';
  sessionPromptHint.textContent = session.IsLive
    ? 'いま見えている session の続きをここから送れます。結果はこの入力欄のすぐ上にある出力欄へ増えていきます。'
    : 'この session は停止済みです。再開したいときは新しく作るか、動作中の session を選んでください。';
  archiveSessionButton.textContent = session.Archived
    ? '一覧へ戻す'
    : '一覧から隠す';
  renameSessionButton.disabled = false;
  archiveSessionButton.disabled = false;
  sendPromptButton.disabled = !session.IsLive;
  sendRawButton.disabled = !session.IsLive;
  sessionPromptInput.disabled = !session.IsLive;
  sessionPromptInput.placeholder = session.IsLive
    ? '例: いまの状況を 3 行で要約して / このテストだけ回して / 続けて'
    : '停止済みの session には送れません。';
  interruptSessionButton.disabled = !session.IsLive;
  closeSessionButton.disabled = !session.IsLive;
  deleteSessionButton.disabled = false;
  sessionPromptInput.value = getSavedDraft(session.Name);
  if (!session.IsLive) {
    stopTranscriptPolling();
    showStoppedSessionTranscript(session.Name);
    return;
  }

  const cachedTranscript = readStoredJson<string>(
    getTranscriptCacheKey(session.Name)
  );
  if (cachedTranscript && !lastTranscript) {
    sessionTranscript.textContent = cachedTranscript;
    lastTranscript = cachedTranscript;
  }
  startTranscriptPolling();
}

async function refreshSessions(): Promise<void> {
  if (isRefreshPaused() || !hasAccessToken()) {
    return;
  }
  try {
    sessions = await apiJson<SessionRecord[]>(
      '/api/sessions?includeArchived=true'
    );
    restorePreferredSelection();
    writeStoredJson(sessionsCacheKey, sessions);
    renderSessions(sessions);
    renderSelectedSession();
    setConnectionState(
      'online',
      `session 一覧を同期しました。最終取得 ${new Date().toLocaleTimeString('ja-JP')}`
    );
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    if (!window.navigator.onLine || error instanceof TypeError) {
      primeCachedSessions();
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function loadDirectorySuggestions(): Promise<void> {
  if (!hasAccessToken()) {
    return;
  }
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
    if (connectionState !== 'online') {
      setConnectionState(
        'online',
        `接続できました。最終確認 ${new Date().toLocaleTimeString('ja-JP')}`
      );
    }
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    if (!window.navigator.onLine || error instanceof TypeError) {
      setConnectionState(
        'offline',
        'フォルダ候補は更新できませんが、前回値のまま操作できます。'
      );
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function startSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    clearPromptDraft(session.Name);
    sessionTitleInput.value = '';
    selectSession(session.Name, { revealPrompt: true });
    showToast('新しい session を開始しました。続きは下の入力欄から送れます。');
    void refreshSessions();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    if (
      handleOfflineError(
        error,
        'ネットワークが戻るまで、前回の session 一覧を表示します。',
        'いまはオフラインです。接続後に新しい session を開始してください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(startSessionButton, false, '');
  }
}

async function sendPrompt(submit: boolean): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    clearPromptDraft(session.Name);
    sessionPromptInput.value = '';
    await refreshTranscript();
    void refreshSessions();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      setAuthOverlayVisible(true);
      return;
    }
    if (
      handleOfflineError(
        error,
        'ネットワークが戻るまで transcript は更新されません。',
        'いまはオフラインです。送信は接続復帰後に再試行してください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(targetButton, false, '');
  }
}

async function renameSelectedSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
  } catch (error) {
    if (
      handleOfflineError(
        error,
        'オフライン中はタイトル変更を反映できません。',
        'いまはオフラインです。タイトル変更は接続後に行ってください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function archiveSelectedSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    if (
      handleOfflineError(
        error,
        'オフライン中は一覧状態を変更できません。',
        'いまはオフラインです。アーカイブ操作は接続後に行ってください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function interruptSelectedSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    if (
      handleOfflineError(
        error,
        'オフライン中は割り込みを送れません。',
        'いまはオフラインです。Ctrl+C は接続後に再試行してください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function closeSelectedSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    if (
      handleOfflineError(
        error,
        'オフライン中は session を閉じられません。',
        'いまはオフラインです。close は接続後に再試行してください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

async function deleteSelectedSession(): Promise<void> {
  if (!hasAccessToken()) {
    setAuthOverlayVisible(true);
    return;
  }
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
    clearPromptDraft(session.Name);
    seenActivityBySession.delete(session.Name);
    persistSeenActivity();
    clearRememberedSession(session.Name);
    lastNotifiedTranscriptBySession.delete(session.Name);
    sessions = sessions.filter((item) => item.Name !== session.Name);
    selectedSessionName = '';
    lastTranscript = '';
    sessionTranscript.textContent = '';
    sessionPromptInput.value = '';
    renderSessions(sessions);
    renderSelectedSession();
    void refreshSessions();
  } catch (error) {
    if (
      handleOfflineError(
        error,
        'オフライン中は削除を反映できません。',
        'いまはオフラインです。削除は接続後に再試行してください。'
      )
    ) {
      return;
    }
    showToast(error instanceof Error ? error.message : String(error));
  }
}

setConnectionState(
  window.navigator.onLine ? 'connecting' : 'offline',
  window.navigator.onLine
    ? 'session 一覧へ接続しています。'
    : 'ネットワークが戻ると自動で同期します。'
);
setInstallUiState();
setNotificationUiState();
setPairingUiState();
workingDirectoryInput.value = config.workspaceRoot;

refreshSessionsButton.addEventListener('click', () => void refreshSessions());
startSessionButton.addEventListener('click', () => void startSession());
openLastSessionButton.addEventListener('click', () => {
  openRememberedSession();
});
showArchivedButton.addEventListener('click', () => {
  includeArchived = !includeArchived;
  showArchivedButton.textContent = includeArchived
    ? '動作中だけ表示'
    : '閉じた session も表示';
  renderSessions(sessions);
  renderSelectedSession();
});
sessionSearchInput.addEventListener('input', () => {
  renderSessions(sessions);
  renderSelectedSession();
});
sessionPromptInput.addEventListener('input', () => {
  persistCurrentPromptDraft();
});
favoriteSessionsOnlyButton.addEventListener('click', () => {
  showFavoriteSessionsOnly = !showFavoriteSessionsOnly;
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
installAppButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    setInstallUiState();
    return;
  }
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await promptEvent.prompt();
  const choice = await promptEvent.userChoice;
  showToast(
    choice.outcome === 'accepted'
      ? 'ホーム画面への追加を受け付けました。'
      : 'ホーム画面への追加は見送りました。'
  );
  setInstallUiState();
});
enableNotificationsButton.addEventListener(
  'click',
  () => void toggleNotifications()
);
lockDeviceButton.addEventListener('click', () => {
  if (
    !window.confirm(
      'この端末に保存したアクセスコードとキャッシュを消して、再入力を必須にします。よろしいですか？'
    )
  ) {
    return;
  }
  lockCurrentDevice();
});
sharePairingButton.addEventListener('click', async () => {
  await sharePairingDetails();
});
copyPairingLinkButton.addEventListener('click', async () => {
  const value = getOneTapPairingLink();
  const copied = await copyText(value);
  showToast(
    copied
      ? 'ワンタップ再接続リンクをコピーしました。'
      : 'リンクをコピーできませんでした。'
  );
});
copyManualUrlButton.addEventListener('click', async () => {
  const value = getPairingBaseUrl();
  const copied = await copyText(value);
  showToast(
    copied ? '接続 URL をコピーしました。' : 'URL をコピーできませんでした。'
  );
});
copyPairingCodeButton.addEventListener('click', async () => {
  const value = getPairingCode();
  if (!value) {
    return;
  }
  const copied = await copyText(value);
  showToast(
    copied
      ? 'アクセスコードをコピーしました。'
      : 'コードをコピーできませんでした。'
  );
});
copySecureLaunchCommandButton.addEventListener('click', async () => {
  const value = secureLaunchCommandInput.value.trim();
  if (!value) {
    return;
  }
  const copied = await copyText(value);
  showToast(
    copied
      ? 'HTTPS 化コマンドをコピーしました。'
      : 'コマンドをコピーできませんでした。'
  );
});
openSecureLaunchSetupButton.addEventListener('click', () => {
  if (!config.tailscaleServeSetupUrl) {
    return;
  }
  window.open(config.tailscaleServeSetupUrl, '_blank', 'noopener,noreferrer');
});

authSubmitButton.addEventListener('click', async () => {
  const nextToken = authTokenInput.value.trim();
  if (!nextToken) {
    return;
  }
  authToken = nextToken;
  writeStoredAuthToken(nextToken);
  setAuthOverlayVisible(false);
  setNotificationUiState();
  setPairingUiState();
  await refreshSessions();
  await loadDirectorySuggestions();
});

openManagerButton.addEventListener('click', () => {
  openManager();
});

function navigateTo(url: string): void {
  const testHook = (
    window as Window & {
      __WORKSPACE_AGENT_HUB_NAVIGATE__?: (nextUrl: string) => void;
    }
  ).__WORKSPACE_AGENT_HUB_NAVIGATE__;
  if (typeof testHook === 'function') {
    testHook(url);
    return;
  }
  window.location.assign(url);
}

function buildManagerUrl(): string {
  const base = new URL(getCurrentPageUrl());
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = basePath ? `${basePath}/manager/` : '/manager/';
  base.search = '';
  base.hash = '';
  if (config.authRequired && authToken) {
    base.hash = `accessCode=${encodeURIComponent(authToken)}`;
  }
  return base.toString();
}

function openManager(): void {
  openManagerButton.disabled = true;
  managerStatus.textContent = '移動しています…';
  try {
    const managerUrl = buildManagerUrl();
    navigateTo(managerUrl);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Manager の起動に失敗しました';
    managerStatus.textContent = message;
    showToast('Manager を開けませんでした');
    openManagerButton.disabled = false;
  }
}

window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refreshSessions();
    if (selectedSessionName) {
      void refreshTranscript();
    }
  }
});
window.addEventListener('online', () => {
  setConnectionState(
    'connecting',
    '接続が戻りました。session 一覧を同期しています。'
  );
  void refreshSessions();
  if (selectedSessionName) {
    void refreshTranscript();
  }
});
window.addEventListener('offline', () => {
  setConnectionState(
    'offline',
    '最後に保存した内容を表示しています。オンラインに戻ると自動で同期します。'
  );
});
window.addEventListener('beforeinstallprompt', (event: Event) => {
  event.preventDefault();
  deferredInstallPrompt = event as BeforeInstallPromptEvent;
  setInstallUiState();
});
window.addEventListener('hashchange', () => {
  if (!applyAccessCodeFromLocationHash()) {
    return;
  }
  setAuthOverlayVisible(false);
  void refreshSessions();
  if (selectedSessionName) {
    void refreshTranscript();
  }
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  setInstallUiState();
  showToast('ホーム画面アプリとして追加されました。');
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

applyAccessCodeFromLocationHash();
if (config.authRequired && !authToken) {
  setAuthOverlayVisible(true);
} else {
  setAuthOverlayVisible(false);
}

primeCachedSessions();
void loadDirectorySuggestions();
void refreshSessions();
sessionPollTimer = window.setInterval(() => void refreshSessions(), 2500);
