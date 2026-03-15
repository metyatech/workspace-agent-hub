import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Server } from 'node:http';
import { PowerShellSessionBridge } from '../src/session-bridge.js';
import type { SessionRecord } from '../src/types.js';
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
    if (session.IsLive) {
      await bridge.closeSession(session.Name);
    }
    await bridge.deleteSession(session.Name);
  }
}

async function expectSessionCard(page: Page, title: string): Promise<void> {
  await expect(
    page.locator('.session-card').filter({ hasText: title })
  ).toHaveCount(1, { timeout: 60000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180000);
  bridge = new PowerShellSessionBridge();
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
  test.setTimeout(180000);
  await cleanupPlaywrightSessions();
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

test('authenticates and manages a shell session from the browser UI', async ({
  page,
}) => {
  test.setTimeout(150000);
  const title = `${titlePrefix} ${Date.now()}`;
  const workingDirectory = 'D:\\ghws\\workspace-agent-hub';
  let createdSessionName = '';

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('heading', { name: 'この画面を開くコードを入力' })
  ).toBeVisible();

  await page.getByLabel('この画面を開くアクセスコード').fill(authToken);
  await page.getByRole('button', { name: '開く' }).click();

  await expect(
    page.getByRole('heading', { name: '最初にやること' })
  ).toBeVisible();
  await expect(page.locator('#workingDirectoryInput')).toHaveValue('D:\\ghws');
  await expect(page.locator('#connectionHint')).toContainText('接続');
  await expect(page.locator('#installHint')).toContainText('ホーム画面');
  await expect(page.locator('#pairingHint')).toContainText('まずこの QR');
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
    timeout: 60000,
  });
  await expectSessionCard(page, title);
  await expect(page.locator('#sessionSearchInput')).toBeVisible();
  await expect(page.locator('#favoriteSessionsOnlyButton')).toBeVisible();
  await expect(page.locator('#selectedSessionState')).toContainText('SHELL');
  await expect(page.locator('#selectedSessionSummary')).toContainText(
    workingDirectory
  );

  const sessions = await bridge.listSessions(true);
  const created = sessions.find((session) => session.DisplayTitle === title);
  expect(created).toBeTruthy();
  createdSessionName = created!.Name;

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
  await page.getByRole('button', { name: '送信して続ける' }).click();
  await expect(page.locator('#sessionTranscript')).toContainText(
    'playwright-browser-path-pass',
    { timeout: 20000 }
  );
  await expect(page.locator('#selectedSessionSummary')).not.toContainText(
    '下書きあり',
    { timeout: 20000 }
  );

  await page.getByRole('button', { name: '閉じた session も表示' }).click();
  await page.getByRole('button', { name: '一覧から隠す' }).click();
  await expect(page.locator('#selectedSessionSummary')).toContainText(
    '一覧では非表示',
    { timeout: 25000 }
  );
  await page.getByRole('button', { name: '一覧へ戻す' }).click();
  await expect(page.locator('#selectedSessionSummary')).not.toContainText(
    '一覧では非表示',
    { timeout: 25000 }
  );

  await page.getByRole('button', { name: '閉じる' }).click();
  await expect
    .poll(async () => {
      const latest = (await bridge.listSessions(true)).find(
        (session) => session.Name === createdSessionName
      ) as SessionRecord | undefined;
      return latest?.IsLive ?? true;
    }, { timeout: 25000 })
    .toBe(false);

  await expect(page.locator('#selectedSessionState')).toContainText('Closed', {
    timeout: 25000,
  });

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '削除' }).click();
  await expect(
    page.locator('.session-card').filter({ hasText: title })
  ).toHaveCount(0, { timeout: 25000 });

  const afterDelete = await bridge.listSessions(true);
  expect(
    afterDelete.some((session) => session.Name === createdSessionName)
  ).toBe(false);

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'この端末をロック' }).click();
  await expect(
    page.getByRole('heading', { name: 'この画面を開くコードを入力' })
  ).toBeVisible();
});
