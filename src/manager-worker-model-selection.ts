import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ManagerRunMode, ManagerWorkerRuntime } from './manager-repos.js';
import { describeWorkerRuntimeCliAvailability } from './manager-worker-runtime.js';
import { wrapWindowsBatchCommandForSpawn } from './windows-batch-spawn.js';

export type WorkerTaskClass =
  | 'codebase-qna'
  | 'test-writing'
  | 'implementation';

export interface WorkerModelCandidate {
  runtime: Extract<ManagerWorkerRuntime, 'opencode' | 'codex' | 'claude'>;
  model: string | null;
  effort: string | null;
  score: number;
  sourceUrls: string[];
  sourceModels: string[];
}

export interface WorkerModelSelection {
  taskClass: WorkerTaskClass;
  selected: WorkerModelCandidate;
  rankedCandidates: WorkerModelCandidate[];
  quotaSummary: string;
}

interface ScaleLeaderboardEntry {
  model: string;
  score: number;
}

interface CandidateMatcher {
  runtime: WorkerModelCandidate['runtime'];
  model: string;
  effort: string | null;
  patterns: RegExp[];
}

interface AiQuotaSnapshot {
  codex?: {
    status?: string;
    display?: string | null;
    data?: {
      primary?: { used_percent?: number | null } | null;
      secondary?: { used_percent?: number | null } | null;
    } | null;
  } | null;
  claude?: {
    status?: string;
    display?: string | null;
    data?: {
      five_hour?: { utilization?: number | null } | null;
      seven_day?: { utilization?: number | null } | null;
    } | null;
  } | null;
}

const SCALE_BENCHMARK_URLS = {
  'codebase-qna': ['https://labs.scale.com/leaderboard/sweatlas-qna'],
  'test-writing': ['https://labs.scale.com/leaderboard/sweatlas-tw'],
  implementation: [
    'https://labs.scale.com/leaderboard/swe_bench_pro_public',
    'https://labs.scale.com/leaderboard/swe_bench_pro_private',
  ],
} satisfies Record<WorkerTaskClass, string[]>;

const SCALE_CACHE_TTL_MS = 5 * 60_000;
const MAX_QUOTA_USED_PERCENT = 90;

const CANDIDATE_MATCHERS: CandidateMatcher[] = [
  {
    runtime: 'codex',
    // Scale labels the strongest ChatGPT-backed Codex implementation entry as
    // gpt-5.4-pro, but the runnable Codex CLI launch model on ChatGPT accounts
    // is still gpt-5.4.
    model: 'gpt-5.4',
    effort: 'xhigh',
    patterns: [/^gpt-5\.4-pro \(xhigh\)\*?$/i],
  },
  {
    runtime: 'codex',
    model: 'gpt-5.4',
    effort: 'xhigh',
    patterns: [
      /^gpt[- ]5\.4[- ]xhigh \(codex(?: cli)?\)$/i,
      /^gpt 5\.4 xhigh \(codex\)$/i,
    ],
  },
  {
    runtime: 'claude',
    model: 'claude-opus-4-6',
    effort: null,
    patterns: [
      /^opus[- ]4\.6 \(claude code\)$/i,
      /^claude-opus-4-6 \(thinking\)\*?$/i,
      /^claude-opus-4-6$/i,
    ],
  },
  {
    runtime: 'claude',
    model: 'claude-sonnet-4-6',
    effort: null,
    patterns: [
      /^sonnet[- ]4\.6 \(claude code\)$/i,
      /^claude-sonnet-4-6(?: \(thinking\))?\*?$/i,
    ],
  },
];

const leaderboardCache = new Map<
  WorkerTaskClass,
  { expiresAt: number; candidates: WorkerModelCandidate[] }
>();

function resolveAiQuotaCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = (
    env.WORKSPACE_AGENT_HUB_AI_QUOTA_PATH ?? env.AI_QUOTA_PATH
  )?.trim();
  if (override) {
    return override;
  }
  if (platform === 'win32') {
    const roamingAppData =
      env.APPDATA?.trim() ||
      (env.USERPROFILE?.trim()
        ? join(env.USERPROFILE.trim(), 'AppData', 'Roaming')
        : '');
    if (roamingAppData) {
      const quotaCmd = join(roamingAppData, 'npm', 'ai-quota.cmd');
      if (existsSync(quotaCmd)) {
        return quotaCmd;
      }
    }
    return 'ai-quota.cmd';
  }
  return 'ai-quota';
}

function normalizeWriteScope(scope: string): string {
  return scope
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
    .toLowerCase();
}

function contentLooksTestOriented(content: string): boolean {
  return /\b(test|tests|testing|unit test|integration test|e2e|spec|specs|regression|coverage|vitest|jest|pytest|playwright|assert|fixture)\b/i.test(
    content
  );
}

function writeScopesLookTestOriented(writeScopes: string[]): boolean {
  return writeScopes.some((scope) => {
    const normalized = normalizeWriteScope(scope);
    return (
      normalized.includes('/test') ||
      normalized.includes('/tests') ||
      normalized.includes('/__tests__') ||
      normalized.includes('.test.') ||
      normalized.includes('.spec.')
    );
  });
}

export function classifyWorkerTask(input: {
  content: string;
  writeScopes: string[];
  runMode: ManagerRunMode | null;
}): WorkerTaskClass {
  if (input.runMode === 'read-only' || input.writeScopes.length === 0) {
    return 'codebase-qna';
  }
  if (
    contentLooksTestOriented(input.content) ||
    writeScopesLookTestOriented(input.writeScopes)
  ) {
    return 'test-writing';
  }
  return 'implementation';
}

function extractBalancedBracketSlice(
  source: string,
  bracketStart: number
): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = bracketStart; index < source.length; index += 1) {
    const ch = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketStart, index + 1);
      }
    }
  }
  throw new Error('Could not parse live leaderboard entries array.');
}

function extractEntriesFragment(html: string): string {
  const searchStart = Math.max(0, html.indexOf('LeaderboardEntriesSection'));
  for (const marker of ['\\"entries\\":', '"entries":']) {
    const markerIndex = html.indexOf(marker, searchStart);
    if (markerIndex < 0) {
      continue;
    }
    const arrayStart = html.indexOf('[', markerIndex);
    if (arrayStart < 0) {
      continue;
    }
    return extractBalancedBracketSlice(html, arrayStart);
  }
  throw new Error('Live leaderboard page did not contain an entries payload.');
}

export function parseScaleLeaderboardEntries(
  html: string
): ScaleLeaderboardEntry[] {
  const fragment = extractEntriesFragment(html).replace(/\\"/g, '"');
  const entries: ScaleLeaderboardEntry[] = [];
  const pattern =
    /{[^{}]*"model":"([^"]+)"[^{}]*"score":([0-9]+(?:\.[0-9]+)?)[^{}]*}/g;
  for (const match of fragment.matchAll(pattern)) {
    const model = match[1]?.trim();
    const score = Number.parseFloat(match[2] ?? '');
    if (!model || !Number.isFinite(score)) {
      continue;
    }
    entries.push({ model, score });
  }
  if (entries.length === 0) {
    throw new Error('No recognizable leaderboard entries were parsed.');
  }
  return entries;
}

function resolveCandidateMatcher(
  sourceModelName: string
): CandidateMatcher | null {
  return (
    CANDIDATE_MATCHERS.find((matcher) =>
      matcher.patterns.some((pattern) => pattern.test(sourceModelName))
    ) ?? null
  );
}

function aggregateCandidates(input: {
  entriesByUrl: Array<{ url: string; entries: ScaleLeaderboardEntry[] }>;
}): WorkerModelCandidate[] {
  const aggregated = new Map<
    string,
    {
      runtime: WorkerModelCandidate['runtime'];
      model: string;
      effort: string | null;
      totalScore: number;
      sourceUrls: Set<string>;
      sourceModels: Set<string>;
      observations: number;
    }
  >();

  for (const source of input.entriesByUrl) {
    for (const entry of source.entries) {
      const match = resolveCandidateMatcher(entry.model);
      if (!match) {
        continue;
      }
      const key = `${match.runtime}:${match.model}:${match.effort ?? ''}`;
      const current = aggregated.get(key) ?? {
        runtime: match.runtime,
        model: match.model,
        effort: match.effort,
        totalScore: 0,
        sourceUrls: new Set<string>(),
        sourceModels: new Set<string>(),
        observations: 0,
      };
      current.totalScore += entry.score;
      current.sourceUrls.add(source.url);
      current.sourceModels.add(entry.model);
      current.observations += 1;
      aggregated.set(key, current);
    }
  }

  return [...aggregated.values()]
    .map((entry) => ({
      runtime: entry.runtime,
      model: entry.model,
      effort: entry.effort,
      score: Number((entry.totalScore / entry.observations).toFixed(2)),
      sourceUrls: [...entry.sourceUrls],
      sourceModels: [...entry.sourceModels],
    }))
    .sort((left, right) => right.score - left.score);
}

function formatCandidateLabel(candidate: {
  runtime: WorkerModelCandidate['runtime'];
  model: string | null;
  effort: string | null;
}): string {
  const modelLabel = candidate.model?.trim() || 'configured-default';
  return candidate.effort
    ? `${candidate.runtime}:${modelLabel} (${candidate.effort})`
    : `${candidate.runtime}:${modelLabel}`;
}

function selectPrimaryOpenCodeCandidate(input: {
  taskClass: WorkerTaskClass;
  supportedRuntimes: Set<WorkerModelCandidate['runtime']>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): WorkerModelSelection | null {
  if (!input.supportedRuntimes.has('opencode')) {
    return null;
  }
  const availability = describeWorkerRuntimeCliAvailability('opencode', {
    platform: input.platform,
    env: input.env,
  });
  if (!availability.available) {
    return null;
  }
  const selected: WorkerModelCandidate = {
    runtime: 'opencode',
    model: input.env.WORKSPACE_AGENT_HUB_OPENCODE_MODEL?.trim() || null,
    effort:
      input.env.WORKSPACE_AGENT_HUB_OPENCODE_VARIANT?.trim() ||
      input.env.WORKSPACE_AGENT_HUB_OPENCODE_EFFORT?.trim() ||
      null,
    score: Number.POSITIVE_INFINITY,
    sourceUrls: [],
    sourceModels: [],
  };
  return {
    taskClass: input.taskClass,
    selected,
    rankedCandidates: [selected],
    quotaSummary: `${formatCandidateLabel(selected)} -> ${availability.detail}`,
  };
}

async function fetchScaleCandidates(
  taskClass: WorkerTaskClass
): Promise<WorkerModelCandidate[]> {
  const now = Date.now();
  const cached = leaderboardCache.get(taskClass);
  if (cached && cached.expiresAt > now) {
    return cached.candidates;
  }

  const entriesByUrl = await Promise.all(
    SCALE_BENCHMARK_URLS[taskClass].map(async (url) => {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'workspace-agent-hub/manager-worker-model-selection',
        },
      });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch live benchmark data from ${url} (${response.status}).`
        );
      }
      return {
        url,
        entries: parseScaleLeaderboardEntries(await response.text()),
      };
    })
  );

  const candidates = aggregateCandidates({ entriesByUrl });
  if (candidates.length === 0) {
    throw new Error(
      `No supported Codex/Claude candidates were found in the live ${taskClass} benchmark data.`
    );
  }

  leaderboardCache.set(taskClass, {
    expiresAt: now + SCALE_CACHE_TTL_MS,
    candidates,
  });
  return candidates;
}

async function readAiQuotaSnapshot(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<AiQuotaSnapshot> {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const stdout = await new Promise<string>((resolve, reject) => {
    const wrappedCommand = wrapWindowsBatchCommandForSpawn(
      resolveAiQuotaCommand(platform, env),
      ['--json'],
      { platform, env }
    );
    execFileCb(
      wrappedCommand.command,
      wrappedCommand.args,
      {
        env,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        shell: wrappedCommand.shell,
        windowsVerbatimArguments: wrappedCommand.windowsVerbatimArguments,
      },
      (error, nextStdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(nextStdout ?? '');
      }
    );
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ai-quota returned invalid JSON.');
  }
  return parsed as AiQuotaSnapshot;
}

function quotaPercent(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function evaluateRuntimeQuota(
  quota: AiQuotaSnapshot,
  runtime: WorkerModelCandidate['runtime']
): { available: boolean; detail: string } {
  if (runtime === 'codex') {
    const codex = quota.codex;
    if (codex?.status !== 'ok') {
      return {
        available: false,
        detail: codex?.display?.trim() || 'codex quota unavailable',
      };
    }
    const primary = quotaPercent(codex.data?.primary?.used_percent);
    const secondary = quotaPercent(codex.data?.secondary?.used_percent);
    const available =
      (primary === null || primary < MAX_QUOTA_USED_PERCENT) &&
      (secondary === null || secondary < MAX_QUOTA_USED_PERCENT);
    return {
      available,
      detail:
        codex.display?.trim() ||
        `5h=${primary ?? '?'}%, 7d=${secondary ?? '?'}% used`,
    };
  }

  const claude = quota.claude;
  if (claude?.status !== 'ok') {
    return {
      available: false,
      detail: claude?.display?.trim() || 'claude quota unavailable',
    };
  }
  const fiveHour = quotaPercent(claude.data?.five_hour?.utilization);
  const sevenDay = quotaPercent(claude.data?.seven_day?.utilization);
  const available =
    (fiveHour === null || fiveHour < MAX_QUOTA_USED_PERCENT) &&
    (sevenDay === null || sevenDay < MAX_QUOTA_USED_PERCENT);
  return {
    available,
    detail:
      claude.display?.trim() ||
      `5h=${fiveHour ?? '?'}%, 7d=${sevenDay ?? '?'}% used`,
  };
}

export async function selectRankedWorkerModel(input: {
  content: string;
  writeScopes: string[];
  runMode: ManagerRunMode | null;
  supportedRuntimes?: ManagerWorkerRuntime[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<WorkerModelSelection> {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const taskClass = classifyWorkerTask(input);
  const supportedRuntimes = new Set(
    (input.supportedRuntimes ?? ['opencode', 'codex', 'claude']).filter(
      (runtime): runtime is WorkerModelCandidate['runtime'] =>
        runtime === 'opencode' || runtime === 'codex' || runtime === 'claude'
    )
  );
  const openCodePrimary = selectPrimaryOpenCodeCandidate({
    taskClass,
    supportedRuntimes,
    platform,
    env,
  });
  if (openCodePrimary) {
    return openCodePrimary;
  }
  const rankedCandidates = (await fetchScaleCandidates(taskClass)).filter(
    (candidate) => supportedRuntimes.has(candidate.runtime)
  );

  if (rankedCandidates.length === 0) {
    throw new Error(
      `No live ranked worker candidates are available for ${taskClass}.`
    );
  }

  const unavailableCliNotes: string[] = [];
  const cliAvailableRuntimes = new Set<WorkerModelCandidate['runtime']>();
  const checkedRuntimes = new Set<WorkerModelCandidate['runtime']>();
  for (const candidate of rankedCandidates) {
    if (checkedRuntimes.has(candidate.runtime)) {
      continue;
    }
    checkedRuntimes.add(candidate.runtime);
    const availability = describeWorkerRuntimeCliAvailability(
      candidate.runtime,
      { platform, env }
    );
    if (availability.available) {
      cliAvailableRuntimes.add(candidate.runtime);
    } else {
      unavailableCliNotes.push(
        `${formatCandidateLabel(candidate)} -> ${availability.detail}`
      );
    }
  }

  if (cliAvailableRuntimes.size === 0) {
    throw new Error(
      `Live-ranked worker candidates were found for ${taskClass}, but none have an installed runtime CLI (${unavailableCliNotes.join(' / ')}).`
    );
  }

  const quota = await readAiQuotaSnapshot({ platform, env });
  checkedRuntimes.clear();
  const quotaNotes: string[] = [];

  for (const candidate of rankedCandidates) {
    if (checkedRuntimes.has(candidate.runtime)) {
      continue;
    }
    checkedRuntimes.add(candidate.runtime);
    if (!cliAvailableRuntimes.has(candidate.runtime)) {
      continue;
    }
    const quotaResult = evaluateRuntimeQuota(quota, candidate.runtime);
    quotaNotes.push(
      `${formatCandidateLabel(candidate)} -> ${quotaResult.detail}`
    );
    if (quotaResult.available) {
      return {
        taskClass,
        selected: candidate,
        rankedCandidates,
        quotaSummary: [...unavailableCliNotes, ...quotaNotes].join(' / '),
      };
    }
  }

  if (quotaNotes.length === 0) {
    throw new Error(
      `Live-ranked worker candidates were found for ${taskClass}, but none have an installed runtime CLI (${unavailableCliNotes.join(' / ')}).`
    );
  }

  if (unavailableCliNotes.length > 0) {
    throw new Error(
      `Live-ranked worker candidates were found for ${taskClass}, but none are currently launchable (${[...unavailableCliNotes, ...quotaNotes].join(' / ')}).`
    );
  }

  throw new Error(
    `Live-ranked worker candidates were found for ${taskClass}, but none currently have sufficient quota (${quotaNotes.join(' / ')}).`
  );
}
