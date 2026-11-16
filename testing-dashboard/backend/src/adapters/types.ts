import { NormalizedTestSuite, SuiteConfig } from '../types';

export interface AdapterExecutionContext {
  runId: string;
  suite: SuiteConfig;
  suiteRootDir: string;     // e.g., testing-suites/arch-project
  suitesPackageRoot: string; // e.g., testing-suites
  targetAppDir: string;     // isolated workspace dir (or source path for attach mode)
  rawReportPath: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  onOutput: (chunk: string, stream?: 'stdout' | 'stderr') => void;
}

export interface AdapterExecutionOutput {
  exitCode: number;
  suites: NormalizedTestSuite[];
}

export interface RunnerAdapter {
  framework: 'vitest' | 'playwright';
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionOutput>;
}
