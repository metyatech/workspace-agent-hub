import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { startWebUi } from './web-ui.js';

const program = new Command();

program
  .name('workspace-agent-hub')
  .description(packageJson.description)
  .version(packageJson.version);

program
  .command('web-ui')
  .description(
    'Start the mobile-friendly browser UI for session management and prompt sending.'
  )
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('--port <port>', 'Port to bind', '3360')
  .option(
    '--auth-token <token>',
    'Access code required by the browser UI. Use auto to generate one, or none to disable auth.'
  )
  .option(
    '--no-open-browser',
    'Do not open a browser automatically after the server starts'
  )
  .action(
    async (options: {
      host: string;
      port: string;
      authToken: string;
      openBrowser?: boolean;
    }) => {
      await startWebUi({
        host: options.host,
        port: Number(options.port),
        authToken: options.authToken,
        openBrowser: options.openBrowser,
      });
    }
  );

await program.parseAsync(process.argv);
