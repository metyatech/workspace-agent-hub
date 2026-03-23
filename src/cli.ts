import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { readManagerWorkItems } from './manager-work-items.js';
import { startWebUi } from './web-ui.js';

type StartWebUiCommand = typeof startWebUi;

export function createProgram(startWebUiCommand: StartWebUiCommand): Command {
  const program = new Command();

  program
    .name('workspace-agent-hub')
    .description(packageJson.description)
    .version(packageJson.version);

  program
    .command('work-items')
    .description('Inspect the Manager work-item graph for a workspace')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print the work-item graph as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workItems = await readManagerWorkItems(options.workspace);
      if (options.json) {
        console.log(JSON.stringify({ workItems }, null, 2));
        return;
      }

      const titleById = new Map(
        workItems.map((item) => [item.id, item.title] as const)
      );
      for (const item of workItems) {
        const parentTitles = item.derivedFromThreadIds
          .map((id) => titleById.get(id) ?? id)
          .filter(Boolean);
        const childTitles = item.derivedChildThreadIds
          .map((id) => titleById.get(id) ?? id)
          .filter(Boolean);
        console.log(`[${item.uiState}] ${item.title}`);
        if (parentTitles.length > 0) {
          console.log(`  derived from: ${parentTitles.join(', ')}`);
        }
        if (childTitles.length > 0) {
          console.log(`  branches: ${childTitles.join(', ')}`);
        }
      }
    });

  program
    .command('web-ui')
    .description(
      'Start the mobile-friendly browser UI for session management and prompt sending.'
    )
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <port>', 'Port to bind', '3360')
    .option(
      '--public-url <url>',
      'Phone-facing HTTPS URL or Tailscale Serve URL used for reconnect links and QR pairing'
    )
    .option(
      '--tailscale-serve',
      'Configure Tailscale Serve for this run and prefer the resulting HTTPS tailnet URL'
    )
    .option(
      '--auth-token <token>',
      'Access code required by the browser UI. Use auto to generate one, or none to disable auth.'
    )
    .option(
      '--json',
      'Print machine-readable launch metadata as a single JSON object'
    )
    .option(
      '--no-open-browser',
      'Do not open a browser automatically after the server starts'
    )
    .action(
      async (options: {
        host: string;
        port: string;
        publicUrl?: string;
        tailscaleServe?: boolean;
        authToken: string;
        json?: boolean;
        openBrowser?: boolean;
      }) => {
        await startWebUiCommand({
          host: options.host,
          port: Number(options.port),
          publicUrl: options.publicUrl,
          tailscaleServe: Boolean(options.tailscaleServe),
          authToken: options.authToken,
          jsonOutput: Boolean(options.json),
          openBrowser: options.openBrowser,
        });
      }
    );

  return program;
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  await createProgram(startWebUi).parseAsync(process.argv);
}
