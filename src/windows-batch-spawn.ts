export interface WindowsBatchSpawnCommand {
  command: string;
  args: string[];
  shell: false;
  windowsVerbatimArguments: boolean;
}

export function isWindowsBatchCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim());
}

function quoteWindowsBatchToken(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function wrapWindowsBatchCommandForSpawn(
  command: string,
  args: string[],
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  }
): WindowsBatchSpawnCommand {
  const platform = options?.platform ?? process.platform;
  if (!isWindowsBatchCommand(command, platform)) {
    return {
      command,
      args,
      shell: false,
      windowsVerbatimArguments: false,
    };
  }

  const env = options?.env ?? process.env;
  const cmdExe = env.ComSpec?.trim() || 'cmd.exe';
  const innerCommand = [
    quoteWindowsBatchToken(command),
    ...args.map((arg) => quoteWindowsBatchToken(arg)),
  ].join(' ');

  return {
    command: cmdExe,
    args: ['/d', '/s', '/c', `"${innerCommand}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}
