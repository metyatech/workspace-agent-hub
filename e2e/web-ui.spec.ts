import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PowerShellSessionBridge } from '../src/session-bridge.js';
import { createWebUiServer } from '../src/web-ui.js';

let baseUrl = '';
const authToken = 'playwright-token';
const titlePrefix = 'Playwright E2E';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(repoRoot, '..');
const sessionCatalogPath =
  process.env.AI_AGENT_SESSION_CATALOG_PATH?.trim() ||
  join(process.env.USERPROFILE ?? homedir(), 'agent-handoff', 'session-catalog.json');

let server: Server;
let bridge: PowerShellSessionBridge;

interface SessionCatalogEntry {
  session_name?: string;
  title?: string;
}

async function readSessionCatalogEntries(): Promise<SessionCatalogEntry[]> {
  try {
    const raw = (await readFile(sessionCatalogPath, 'utf8')).trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as SessionCatalogEntry | SessionCatalogEntry[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function findPlaywrightSessionNames(): Promise<string[]> {
  const entries = await readSessionCatalogEntries();
  if (entries.length > 0) {
    return entries
      .filter(
        (entry) =>
          typeof entry.session_name === 'string' &&
          typeof entry.title === 'string' &&
          entry.title.startsWith(titlePrefix)
      )
      .map((entry) => entry.session_name!.trim())
      .filter((sessionName) => sessionName.length > 0);
  }
  const sessions = await bridge.listSessions(true);
  return sessions
    .filter((session) => session.DisplayTitle.startsWith(titlePrefix))
    .map((session) => session.Name);
}

async function hasCatalogSessionWithTitle(title: string): Promise<boolean> {
  return (await readSessionCatalogEntries()).some(
    (entry) =>
      typeof entry.session_name === 'string' &&
      typeof entry.title === 'string' &&
      entry.title === title
  );
}

async function cleanupPlaywrightSessions(): Promise<void> {
  for (const sessionName of await findPlaywrightSessionNames()) {
    try {
      await bridge.deleteSession(sessionName);
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function expectSessionCard(page: Page, title: string): Promise<void> {
  await expect(
    page.locator('.session-card').filter({ hasText: title })
  ).toHaveCount(1, { timeout: 120000 });
}

function formatAxeViolations(violations: AxeResults['violations']): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.flatMap((node) => node.target).join(', ');
      return `${violation.id}: ${violation.help} [${targets}]`;
    })
    .join('\n');
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22a',
      'wcag22aa',
      'best-practice',
    ])
    .analyze();
  expect(results.violations, formatAxeViolations(results.violations)).toEqual(
    []
  );
}

async function openManager(page: Page): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Manager を開く' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Manager を開く' }).click();

  await expect(page).toHaveURL(new RegExp(`/manager/(?:#.*)?$`));
  await expect(page.locator('h1.manager-bar-title')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(600000);

test.beforeAll(async () => {
  bridge = new PowerShellSessionBridge({ workspaceRoot });
  await cleanupPlaywrightSessions();
  const started = await createWebUiServer({
    host: '127.0.0.1',
    port: 0,
    authToken,
    publicUrl: 'https://hub.example.test/connect',
    openBrowser: false,
    bridge,
  });
  server = started.server;
  baseUrl = `http://127.0.0.1:${started.port}`;
});

test.afterAll(async () => {
  if (!server) {
    return;
  }
  await cleanupPlaywrightSessions();
  const closePromise = new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await Promise.race([
    closePromise,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1000)),
  ]);
});

async function expectAuthScreenOwnsViewport(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'この画面を開くコードを入力' })
  ).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        htmlLocked: document.documentElement.classList.contains('auth-locked'),
        authLocked: document.body.classList.contains('auth-locked'),
        shellPointerEvents: getComputedStyle(
          document.querySelector('.shell') as HTMLElement
        ).pointerEvents,
        topElement:
          document
            .elementFromPoint(Math.floor(window.innerWidth / 2), 24)
            ?.closest('#authOverlay')?.id ?? '',
      }))
    )
    .toEqual({
      htmlLocked: true,
      authLocked: true,
      shellPointerEvents: 'none',
      topElement: 'authOverlay',
    });
}

test('authenticates and manages a shell session from the browser UI', async ({
  page,
}) => {
  test.setTimeout(600000);
  const title = `${titlePrefix} ${Date.now()}-${test.info().repeatEachIndex}`;
  const workingDirectory = repoRoot;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expectAuthScreenOwnsViewport(page);

  await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
  await page.getByRole('button', { name: '開く', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: '最初にやること' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '新しく始める', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '一覧から選ぶ', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: '一覧から選ぶ', exact: true }).click();
  await expect(page.locator('#sessionSearchInput')).toBeFocused();
  await page.getByRole('button', { name: '新しく始める', exact: true }).click();
  await expect(page.locator('#sessionTitleInput')).toBeFocused();
  await expect(page.locator('#workingDirectoryInput')).toHaveValue(
    workspaceRoot
  );
  await expect(page.locator('#connectionHint')).toContainText('接続');
  await expect(page.locator('#installHint')).toContainText('ホーム画面');
  await expect(page.locator('#pairingHint')).toContainText(
    'この URL をスマホで開きます'
  );
  await expect(page.locator('#pairingUrlInput')).toHaveValue(
    /#accessCode=playwright-token$/
  );
  await expect(page.locator('#pairingCodeInput')).toHaveValue(
    'playwright-token'
  );
  await expect(page.locator('#pairingQrImage')).toHaveAttribute(
    'src',
    /data:image\/png;base64,/
  );
  await expect(page.locator('#secureLaunchShell')).toBeHidden();

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    )
    .toBe(true);

  await page.selectOption('#sessionTypeSelect', 'shell');
  await page.locator('#sessionTitleInput').fill(title);
  await page.locator('#workingDirectoryInput').fill(workingDirectory);
  await page.locator('#startSessionButton').click();

  await expect(page.locator('#startSessionButton')).toBeEnabled({
    timeout: 120000,
  });
  await expectSessionCard(page, title);
  await expect(page.locator('#sessionSearchInput')).toBeVisible();
  await expect(page.locator('#favoriteSessionsOnlyButton')).toBeVisible();
  await expect(page.locator('#selectedSessionState')).toContainText('SHELL');
  await expect(page.locator('#selectedSessionSummary')).toContainText(
    workingDirectory
  );
  await expect(page.locator('#sessionPromptHint')).toContainText(
    'この入力欄のすぐ上にある出力欄'
  );
  await expect(page.locator('#sessionPromptInput')).toBeFocused();

  await expect
    .poll(async () => hasCatalogSessionWithTitle(title))
    .toBe(true);

  await page.locator('#sessionPromptInput').fill('draft-before-reload');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#lastSessionCard')).toBeVisible();
  await expect(page.locator('#lastSessionTitle')).toContainText(title);
  if (
    !(await page.locator('#selectedSessionState').textContent())?.includes(
      'SHELL'
    )
  ) {
    await page.getByRole('button', { name: '前回の session を開く' }).click();
  }
  await expect(page.locator('#selectedSessionState')).toContainText('SHELL');
  await expect(page.locator('#sessionPromptInput')).toHaveValue(
    'draft-before-reload'
  );

  await page
    .locator('#sessionPromptInput')
    .fill('echo playwright-browser-path-pass');
  await page.getByRole('button', { name: 'AI に送る' }).click();
  await expect(page.locator('#sessionTranscript')).toContainText(
    'playwright-browser-path-pass',
    { timeout: 60000 }
  );
  await expect(page.locator('#selectedSessionSummary')).not.toContainText(
    '下書きあり',
    { timeout: 60000 }
  );

  await page.getByRole('button', { name: '一覧から隠す' }).click();
  await expect(page.locator('#selectedSessionSummary')).toContainText(
    '一覧では非表示',
    { timeout: 60000 }
  );
  await page.getByRole('button', { name: '一覧へ戻す' }).click();
  await expect(page.locator('#selectedSessionSummary')).not.toContainText(
    '一覧では非表示',
    { timeout: 60000 }
  );

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'この端末をロック' }).click();
  await expect(
    page.getByRole('heading', { name: 'この画面を開くコードを入力' })
  ).toBeVisible();
});

test('keeps the access-code screen above the hub on desktop and mobile widths', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1365, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await expectAuthScreenOwnsViewport(page);
  }
});

test('opens Manager from Hub in the same tab on desktop', async ({ page }) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Manager を開く' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Manager を開く' }).click();

  await expect(page).toHaveURL(new RegExp(`/manager/(?:#.*)?$`));
  await expect(page.locator('h1.manager-bar-title')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '↻ 更新', exact: true })
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'この画面を開くコードを入力' })
  ).toHaveCount(0);
});

test('opens Manager from Hub on mobile width without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Manager を開く' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Manager を開く' }).click();

  await expect(page).toHaveURL(new RegExp(`/manager/(?:#.*)?$`));
  await expect(page.locator('h1.manager-bar-title')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '↻ 更新', exact: true })
  ).toHaveCount(0);
  const sendNowButton = page.getByRole('button', {
    name: 'いま依頼を送る',
    exact: true,
  });
  await expect(sendNowButton).toBeVisible();
  await sendNowButton.click();
  await expect(page.getByLabel('Manager への送信内容')).toBeVisible();
  await expect(page.locator('#composerMediaHint')).toContainText(
    'Ctrl / Cmd + V'
  );
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    )
    .toBe(true);
});

test('keeps the Manager auth screen accessible', async ({ page }) => {
  await page.goto(`${baseUrl}/manager/`, { waitUntil: 'domcontentloaded' });

  await expect(
    page.getByRole('heading', {
      name: 'Manager は、あとで状況を見失わないための受信箱です',
    })
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
});

test('loads Manager directly without a trailing slash', async ({ page }) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const liveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/manager/api/live') &&
      response.request().method() === 'GET' &&
      response.status() === 200
  );

  await page.goto(`${baseUrl}/manager#accessCode=${authToken}`, {
    waitUntil: 'domcontentloaded',
  });

  await liveResponse;
  await expect(page.locator('h1.manager-bar-title')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/manager(?:/(?:#.*)?)?$`));
});

test('keeps the unlocked Manager inbox accessible on desktop and mobile', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1365, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await openManager(page);
    await expect(
      page.getByRole('button', { name: '↻ 更新', exact: true })
    ).toHaveCount(0);
    await expectNoAccessibilityViolations(page);
  }
});
