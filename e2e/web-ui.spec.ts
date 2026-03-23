import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AxeResults } from 'axe-core';
import type { Server } from 'node:http';
import { PowerShellSessionBridge } from '../src/session-bridge.js';
import { createWebUiServer } from '../src/web-ui.js';

let baseUrl = '';
const authToken = 'playwright-token';
const titlePrefix = 'Playwright E2E';

let server: Server;
let bridge: PowerShellSessionBridge;

async function cleanupPlaywrightSessions(): Promise<void> {
  const sessions = await bridge.listSessions(true);
  const targets = sessions.filter((session) =>
    session.DisplayTitle.startsWith(titlePrefix)
  );

  for (const session of targets) {
    try {
      if (session.IsLive) {
        await bridge.closeSession(session.Name);
      }
    } catch {
      /* best-effort cleanup */
    }
    try {
      await bridge.deleteSession(session.Name);
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
  bridge = new PowerShellSessionBridge();
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
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
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
  const workingDirectory = 'D:\\ghws\\workspace-agent-hub';

  try {
    await cleanupPlaywrightSessions();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectAuthScreenOwnsViewport(page);

    await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
    await page.getByRole('button', { name: '開く', exact: true }).click();

    await expect(
      page.getByRole('heading', { name: '最初にやること' })
    ).toBeVisible();
    await expect(page.locator('#workingDirectoryInput')).toHaveValue(
      'D:\\ghws'
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

    const sessions = await bridge.listSessions(true);
    const created = sessions.find((session) => session.DisplayTitle === title);
    expect(created).toBeTruthy();

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
  } finally {
    await cleanupPlaywrightSessions();
  }
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
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectAuthScreenOwnsViewport(page);
  }
});

test('opens Manager from Hub in the same tab on desktop', async ({ page }) => {
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
  await expect(
    page.getByRole('button', { name: '↻ 更新', exact: true })
  ).toHaveCount(0);
  const openComposerButton = page.getByRole('button', {
    name: '送信欄を開く',
    exact: true,
  });
  await expect(openComposerButton).toBeVisible();
  await openComposerButton.dispatchEvent('click');
  if (!(await page.getByLabel('Manager への送信内容').isVisible())) {
    await openComposerButton.dispatchEvent('click');
  }
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
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(
    page.getByRole('heading', {
      name: 'Manager は、あとで状況を見失わないための受信箱です',
    })
  ).toBeVisible();
  await expectNoAccessibilityViolations(page);
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
