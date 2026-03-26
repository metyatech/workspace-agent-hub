import { execFile as execFileCb } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

export interface BuildMetadata {
  commitHash: string;
  commitHashFull: string;
  commitMessage: string;
  commitDate: string;
  archivedAt: string;
  version: string;
}

export interface ArchivedBuild extends BuildMetadata {
  distPath: string;
}

const MAX_BUILDS = 20;

export function getBuildArchiveRoot(): string {
  return join(homedir(), '.cache', 'workspace-agent-hub', 'builds');
}

function execGitField(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFileCb('git', args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolvePromise(stdout.trim());
      }
    });
  });
}

export async function getGitInfo(packageRoot: string): Promise<{
  hash: string;
  hashFull: string;
  message: string;
  date: string;
}> {
  const [hash, hashFull, message, date] = await Promise.all([
    execGitField(packageRoot, ['rev-parse', '--short', 'HEAD']),
    execGitField(packageRoot, ['rev-parse', 'HEAD']),
    execGitField(packageRoot, ['log', '-1', '--format=%s']),
    execGitField(packageRoot, ['log', '-1', '--format=%aI']),
  ]);
  return { hash, hashFull, message, date };
}

export async function snapshotBuild(
  packageRoot: string
): Promise<ArchivedBuild> {
  const distDir = join(packageRoot, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`dist/ directory not found at ${distDir}`);
  }

  const git = await getGitInfo(packageRoot);
  const archiveDir = join(getBuildArchiveRoot(), git.hashFull);
  const archiveDistDir = join(archiveDir, 'dist');

  await mkdir(archiveDir, { recursive: true });
  await cp(distDir, archiveDistDir, { recursive: true });

  let version = 'unknown';
  try {
    const pkgPath = join(packageRoot, 'package.json');
    const pkgContent = await readFile(pkgPath, 'utf-8');
    version =
      (JSON.parse(pkgContent) as { version?: string }).version ?? version;
  } catch {
    /* ignore */
  }

  const metadata: BuildMetadata = {
    commitHash: git.hash,
    commitHashFull: git.hashFull,
    commitMessage: git.message,
    commitDate: git.date,
    archivedAt: new Date().toISOString(),
    version,
  };

  await writeFile(
    join(archiveDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  await pruneBuilds();

  return { ...metadata, distPath: archiveDistDir };
}

export async function listBuilds(): Promise<ArchivedBuild[]> {
  const root = getBuildArchiveRoot();
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const builds: ArchivedBuild[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const metaPath = join(root, entry.name, 'metadata.json');
    if (!existsSync(metaPath)) {
      continue;
    }
    try {
      const content = await readFile(metaPath, 'utf-8');
      const meta = JSON.parse(content) as BuildMetadata;
      builds.push({
        ...meta,
        distPath: join(root, entry.name, 'dist'),
      });
    } catch {
      /* skip corrupted entries */
    }
  }

  return builds.sort(
    (a, b) =>
      new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime()
  );
}

export async function pruneBuilds(maxBuilds = MAX_BUILDS): Promise<string[]> {
  const builds = await listBuilds();
  if (builds.length <= maxBuilds) {
    return [];
  }

  const toRemove = builds.slice(maxBuilds);
  const removed: string[] = [];

  for (const build of toRemove) {
    const archiveDir = join(getBuildArchiveRoot(), build.commitHashFull);
    try {
      await rm(archiveDir, { recursive: true, force: true });
      removed.push(build.commitHash);
    } catch {
      /* ignore cleanup failures */
    }
  }

  return removed;
}

export async function restoreBuild(
  commitHash: string,
  packageRoot: string
): Promise<ArchivedBuild | null> {
  const builds = await listBuilds();
  const normalizedHash = commitHash.trim().toLowerCase();
  const match = builds.find(
    (b) =>
      b.commitHashFull.toLowerCase() === normalizedHash ||
      b.commitHash.toLowerCase() === normalizedHash ||
      b.commitHashFull.toLowerCase().startsWith(normalizedHash)
  );

  if (!match) {
    return null;
  }

  if (!existsSync(match.distPath)) {
    return null;
  }

  const targetDist = join(packageRoot, 'dist');

  // Remove current dist
  if (existsSync(targetDist)) {
    await rm(targetDist, { recursive: true, force: true });
  }

  // Copy archived dist into place
  await cp(match.distPath, targetDist, { recursive: true });

  return match;
}

export function resolvePackageRoot(): string {
  const thisFile = new URL('.', import.meta.url).pathname.replace(
    /^\/([A-Z]:)/i,
    '$1'
  );
  return resolvePath(thisFile, '..');
}
