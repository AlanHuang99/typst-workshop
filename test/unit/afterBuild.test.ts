import { beforeEach, describe, expect, test, vi } from 'vitest';
import { afterBuild, type AfterBuildDeps } from '../../src/build/afterBuild';
import { readConfig } from '../../src/config';
import { memoryLogger } from '../../src/log';
import type { BuildOutcome, Project } from '../../src/project/project';
import { testHooks } from './vscode-stub';

const result = { success: true, durationMs: 120, pageCount: 2, pdfWritten: true, diagnostics: [], dependencies: ['/w/main.typ'] };
const project = { entry: '/w/main.typ', root: '/w', pdf: '/w/main.pdf', wordCount: async () => ({ total: 3, files: [] }) } as unknown as Project;

/** Dependencies that record the order of the steps. */
function recordingDeps(): AfterBuildDeps & { steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    config: () => readConfig(),
    status: { update: (s) => steps.push(`status ${s.kind}`), setWordCount: (r) => steps.push(`words ${r?.total}`) },
    diagnostics: { publish: () => steps.push('diagnostics') },
    viewers: { buildFinished: async (pdf, written) => void steps.push(`tabs ${pdf} ${written}`) },
    showFailure: () => steps.push('popup'),
    syncAfterBuild: async () => void steps.push('sync'),
    logger: memoryLogger(),
  };
}

beforeEach(() => testHooks.reset());

describe('after a build', () => {
  test('the status item first, then the diagnostics, the tabs of the PDF, the word count and sync after build', async () => {
    testHooks.config['typst-workshop.sync.afterBuild'] = true;
    const deps = recordingDeps();
    const outcome: BuildOutcome = { trigger: 'save', at: new Date(), result };
    await afterBuild(project, outcome, '/w/main.pdf', deps);
    expect(deps.steps).toEqual(['status ok', 'diagnostics', 'tabs /w/main.pdf true', 'words 3', 'sync']);
  });

  test('the tabs of the PDF settle even when reading the settings or updating the status item throws', async () => {
    const outcome: BuildOutcome = { trigger: 'save', at: new Date(), result };
    const brokenSettings = recordingDeps();
    brokenSettings.config = () => {
      throw new Error('settings broke');
    };
    await expect(afterBuild(project, outcome, '/w/main.pdf', brokenSettings)).rejects.toThrow('settings broke');
    expect(brokenSettings.steps).toEqual(['tabs /w/main.pdf true']);

    const brokenStatus = recordingDeps();
    brokenStatus.status.update = vi.fn(() => {
      throw new Error('status broke');
    });
    await expect(afterBuild(project, { trigger: 'save', at: new Date(), error: 'helper missing' }, '/w/old.pdf', brokenStatus)).rejects.toThrow('status broke');
    expect(brokenStatus.steps).toEqual(['tabs /w/old.pdf false']);
  });

  test('a failed build settles the tabs and shows the popup when message.error.show is on', async () => {
    testHooks.config['typst-workshop.message.error.show'] = true;
    const deps = recordingDeps();
    const failed = { ...result, success: false, pdfWritten: false, diagnostics: [{ severity: 'error' as const, message: 'unknown variable: x', hints: [], path: null, range: null, trace: [] }] };
    await afterBuild(project, { trigger: 'save', at: new Date(), result: failed }, '/w/main.pdf', deps);
    expect(deps.steps).toEqual(['status failed', 'diagnostics', 'tabs /w/main.pdf false', 'popup']);
  });
});
