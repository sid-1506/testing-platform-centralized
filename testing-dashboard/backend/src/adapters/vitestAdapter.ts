import fs from 'fs';
import path from 'path';
import { NormalizedTestCase, NormalizedTestSuite } from '../types';
import { spawnTrackedProcess } from '../services/processManager';
import { AdapterExecutionContext, AdapterExecutionOutput, RunnerAdapter } from './types';

interface VitestAssertionResult {
  fullName?: string;
  title?: string;
  status?: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
  duration?: number;
  failureMessages?: string[];
}

interface VitestFileResult {
  name?: string;
  startTime?: number;
  endTime?: number;
  assertionResults?: VitestAssertionResult[];
}

interface VitestJsonReport {
  testResults?: VitestFileResult[];
}

export const vitestAdapter: RunnerAdapter = {
  framework: 'vitest',

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const vitestBin = path.join(ctx.suitesPackageRoot, 'node_modules', '.bin', 'vitest');
    if (!fs.existsSync(vitestBin)) {
      throw new Error(`Vitest binary not found at ${vitestBin}. Run npm install in testing-suites/.`);
    }

    const args = [
      'run',
      ctx.suite.targetFile,
      '--reporter=verbose',
      '--reporter=json',
      `--outputFile=${ctx.rawReportPath}`,
    ];

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawnTrackedProcess(
        ctx.runId,
        `vitest:${ctx.suite.id}`,
        vitestBin,
        args,
        ctx.suiteRootDir,
        {
          ...process.env,
          ...ctx.env,
          TARGET_APP_DIR: ctx.targetAppDir,
        },
        ctx.onOutput
      );

      const timer = setTimeout(() => {
        ctx.onOutput(`\n[PLATFORM] Test execution timed out after ${ctx.timeoutMs}ms.\n`);
        reject(new Error(`Vitest execution timed out after ${ctx.timeoutMs}ms`));
      }, ctx.timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    const suites: NormalizedTestSuite[] = [];
    if (fs.existsSync(ctx.rawReportPath)) {
      const raw = JSON.parse(fs.readFileSync(ctx.rawReportPath, 'utf8')) as VitestJsonReport;
      for (const fileRes of raw.testResults || []) {
        const cases: NormalizedTestCase[] = (fileRes.assertionResults || []).map((ar) => {
          const status: NormalizedTestCase['status'] =
            ar.status === 'passed' ? 'passed' : ar.status === 'failed' ? 'failed' : 'skipped';
          const firstErr = ar.failureMessages?.[0];
          return {
            name: ar.fullName || ar.title || 'Unnamed test',
            status,
            durationMs: Math.round(ar.duration || 0),
            ...(firstErr
              ? {
                  error: {
                    message: firstErr.split('\n')[0],
                    stack: firstErr,
                  },
                }
              : {}),
          };
        });

        const fileDuration =
          fileRes.endTime && fileRes.startTime
            ? Math.max(0, Math.round(fileRes.endTime - fileRes.startTime))
            : cases.reduce((acc, c) => acc + c.durationMs, 0);

        suites.push({
          name: fileRes.name ? path.relative(ctx.suiteRootDir, fileRes.name) : ctx.suite.targetFile,
          layer: ctx.suite.layer,
          durationMs: fileDuration,
          cases,
        });
      }
    }

    return { exitCode, suites };
  },
};
