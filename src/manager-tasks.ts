import { readFile } from 'fs/promises';
import { join } from 'path';

export interface Task {
  id: string;
  description: string;
  stage: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export async function readTasks(dir: string): Promise<Task[]> {
  const filePath = join(dir, '.tasks.jsonl');
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: Task[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      tasks.push(JSON.parse(trimmed) as Task);
    } catch {
      process.stderr.write(
        `[tasks] Skipping malformed line: ${trimmed.slice(0, 80)}\n`
      );
    }
  }
  return tasks;
}

// Stages that are considered complete/no-longer-actionable and hidden by default in the GUI.
const INACTIVE_STAGES = new Set(['done', 'released', 'committed']);

export async function readActiveTasks(dir: string): Promise<Task[]> {
  const tasks = await readTasks(dir);
  return tasks.filter((t) => !INACTIVE_STAGES.has(t.stage));
}
