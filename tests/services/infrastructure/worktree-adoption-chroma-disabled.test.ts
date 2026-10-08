// #4563: CLAUDE_MEM_CHROMA_ENABLED=false skips ChromaMcpManager in the worker and
// in search, but worktree adoption built its own ChromaSync and spawned chroma-mcp
// on every start anyway. On a host where chroma-mcp crashes this relaunches the
// crashing process each time the worker starts.
//
// Adoption's SQLite work must still happen; only the Chroma patch is skipped.
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
const chromaToolCalls: string[] = [];
let getInstanceCalls = 0;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => {
      getInstanceCalls++;
      return {
        callTool: async (name: string) => {
          chromaToolCalls.push(name);
          return {};
        }
      };
    }
  }
}));

import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

let tempRoot: string | undefined;
const originalChromaEnabled = process.env.CLAUDE_MEM_CHROMA_ENABLED;

beforeEach(() => {
  chromaToolCalls.length = 0;
  getInstanceCalls = 0;
});

afterEach(() => {
  if (originalChromaEnabled === undefined) delete process.env.CLAUDE_MEM_CHROMA_ENABLED;
  else process.env.CLAUDE_MEM_CHROMA_ENABLED = originalChromaEnabled;
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function seedOrphanedWorktreeObservation(): { mainRepo: string; dataDirectory: string; dbPath: string } {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-4563-'));
  const mainRepo = path.join(tempRoot, 'parent-repo');
  const worktree = path.join(tempRoot, 'gone-wt');
  const dataDirectory = path.join(tempRoot, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(mainRepo, { recursive: true });
  git(mainRepo, 'init', '-b', 'main');
  git(mainRepo, 'config', 'user.email', 'test@example.com');
  git(mainRepo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(mainRepo, 'README.md'), 'base\n');
  git(mainRepo, 'add', 'README.md');
  git(mainRepo, 'commit', '-m', 'base');
  git(mainRepo, 'worktree', 'add', '-b', 'gone', worktree);

  const dbPath = path.join(dataDirectory, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const sessionDbId = store.createSDKSession('content-gone', 'parent-repo/gone-wt', 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-gone');
  store.importObservation({
    memory_session_id: 'memory-gone',
    project: 'parent-repo/gone-wt',
    text: 'worktree work',
    type: 'discovery',
    title: 'work in gone-wt',
    subtitle: null,
    facts: null,
    narrative: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: new Date(1_700_000_000_000).toISOString(),
    created_at_epoch: 1_700_000_000_000,
  });
  store.close();

  git(mainRepo, 'worktree', 'remove', '--force', worktree);
  git(mainRepo, 'worktree', 'prune');
  return { mainRepo, dataDirectory, dbPath };
}

describe('worktree adoption honors CLAUDE_MEM_CHROMA_ENABLED (#4563)', () => {
  it('does not touch Chroma when it is disabled, but still adopts the rows', async () => {
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
    const { mainRepo, dataDirectory } = seedOrphanedWorktreeObservation();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(1);
    expect(getInstanceCalls).toBe(0);
    expect(chromaToolCalls).toEqual([]);
    expect(result.chromaUpdates).toBe(0);
    expect(result.chromaFailed).toBe(0);
  }, 30_000);

  it('still patches Chroma when it is enabled', async () => {
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'true';
    const { mainRepo, dataDirectory } = seedOrphanedWorktreeObservation();

    const result = await adoptMergedWorktrees({ repoPath: mainRepo, dataDirectory });

    expect(result.adoptedObservations).toBe(1);
    expect(getInstanceCalls).toBeGreaterThan(0);
    expect(result.chromaUpdates).toBe(1);
  }, 30_000);
});
