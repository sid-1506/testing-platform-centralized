import { spawn } from 'child_process';
import { playwrightBrowsersPath } from '../config';

export interface HeadlessFinding {
  /** Main browser processes seen so far that belong to Playwright's browser cache. */
  headless: number;
  headed: number;
  sample?: string;
}

function psCommands(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-axo', 'command='], { stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(out.split('\n')));
  });
}

/**
 * Safety net that proves external suites run headlessly: periodically inspects
 * Playwright-managed browser processes. A main browser process (no --type=) is
 * headless when it is chrome-headless-shell or was started with --headless.
 */
export function startHeadlessGuard(opts: {
  intervalMs?: number;
  onHeaded: (cmd: string) => void;
  onHeadless: (summary: HeadlessFinding) => void;
}): { stop: () => HeadlessFinding } {
  const browsersPath = playwrightBrowsersPath();
  const finding: HeadlessFinding = { headless: 0, headed: 0 };
  let reportedHeadless = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const lines = await psCommands();
    let headless = 0;
    let headed = 0;
    let sample: string | undefined;
    for (const line of lines) {
      if (!line.includes(browsersPath)) continue;
      if (line.includes(' --type=')) continue; // renderer/gpu/utility helpers
      if (/ffmpeg|playwright-core|node_modules/.test(line) && !/chrom|firefox|webkit|Safari/i.test(line)) continue;
      const isHeadlessShell = /chrome-headless-shell|headless_shell/.test(line);
      if (isHeadlessShell || /--headless/.test(line)) {
        headless += 1;
        sample = sample || line.slice(0, 160);
      } else if (/chrom|firefox|webkit|MiniBrowser/i.test(line)) {
        headed += 1;
        sample = line.slice(0, 160);
        finding.headed += 1;
        opts.onHeaded(line.slice(0, 200));
      }
    }
    if (headless > 0) {
      finding.headless = Math.max(finding.headless, headless);
      finding.sample = finding.sample || sample;
      if (!reportedHeadless && headed === 0) {
        reportedHeadless = true;
        opts.onHeadless({ ...finding, headless });
      }
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? 2500);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      return finding;
    },
  };
}
