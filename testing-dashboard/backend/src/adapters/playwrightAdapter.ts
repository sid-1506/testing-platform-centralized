import fs from 'fs';
import path from 'path';
import { NormalizedTestSuite } from '../types';
import { PwJsonReport, parsePlaywrightJson } from './playwrightReport';
import { spawnTrackedProcess } from '../services/processManager';
import { AdapterExecutionContext, AdapterExecutionOutput, RunnerAdapter } from './types';

export const playwrightAdapter: RunnerAdapter = {
  framework: 'playwright',

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionOutput> {
    const pwBin = path.join(ctx.suitesPackageRoot, 'node_modules', '.bin', 'playwright');
    if (!fs.existsSync(pwBin)) {
      throw new Error(`Playwright binary not found at ${pwBin}. Run npm install in testing-suites/.`);
    }

    const args = ['test', ctx.suite.targetFile, '--reporter=json'];

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawnTrackedProcess(
        ctx.runId,
        `playwright:${ctx.suite.id}`,
        pwBin,
        args,
        ctx.suiteRootDir,
        {
          ...process.env,
          ...ctx.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: ctx.rawReportPath,
        },
        ctx.onOutput
      );

      const timer = setTimeout(() => {
        ctx.onOutput(`\n[PLATFORM] Playwright execution timed out after ${ctx.timeoutMs}ms.\n`);
        reject(new Error(`Playwright execution timed out after ${ctx.timeoutMs}ms`));
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
      const raw = JSON.parse(fs.readFileSync(ctx.rawReportPath, 'utf8')) as PwJsonReport;
      // Shared parser: keeps every attempt (retries/flaky), timedOut/interrupted statuses, ids and locations.
      const parsed = parsePlaywrightJson(raw, { layer: ctx.suite.layer });
      const cases = parsed.suites.flatMap((s) =>
        s.cases.map((c) => ({ ...c, name: c.fullTitle ? c.fullTitle.replace(/ › /g, ' > ') : c.name }))
      );
      suites.push({
        name: ctx.suite.targetFile,
        layer: ctx.suite.layer,
        durationMs: cases.reduce((acc, c) => acc + c.durationMs, 0),
        cases,
      });
    }

    return { exitCode, suites };
  },
};
