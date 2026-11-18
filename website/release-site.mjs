import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertStepSucceeded,
  createDefaultRunner,
  createNativeReleaseCommand,
  parseNativeReleaseOutput,
} from '@iris/release-tools';

const filename = fileURLToPath(import.meta.url);
const appDir = path.resolve(path.dirname(filename), '..');
const distDir = path.join(appDir, 'website', 'dist');
const treeName = 'nostr-backup-site';
const defaultRunner = createDefaultRunner();

export function createSiteReleasePlan({ deploy = false, dryRun = false, gatePath } = {}) {
  const steps = [
    { id: 'test', label: 'Run Social Backup release tests', command: ['pnpm', 'test:release'], cwd: appDir },
    { id: 'build', label: 'Build Social Backup website', command: ['pnpm', 'run', 'build:site'], cwd: appDir },
    {
      id: 'publish',
      label: 'Verify and publish Social Backup website through native Iris Drive',
      command: createNativeReleaseCommand({
        distDir,
        treeName,
        resolveHtreeCommand: () => [process.env.HTREE_BIN || 'htree'],
        dryRun,
        gatePath,
      }),
      cwd: distDir,
    },
  ];
  if (deploy) {
    steps.push({
      id: 'deploy',
      label: 'Deploy Social Backup website to Cloudflare',
      command: ['wrangler', 'deploy', '--config', 'website/wrangler.jsonc'],
      cwd: appDir,
    });
  }
  return steps;
}

export async function runSiteRelease(options, runner = defaultRunner) {
  const steps = createSiteReleasePlan(options);
  if (options.dryRun) return { steps };

  let publish;
  for (const step of steps) {
    const result = await runner(step);
    assertStepSucceeded(step, result);
    if (step.id === 'publish') {
      publish = parseNativeReleaseOutput(`${result.stdout}\n${result.stderr}`, treeName);
    }
  }
  return { publish };
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try {
    const flags = new Set(process.argv.slice(2).filter(arg => arg !== '--'));
    if ([...flags].some(flag => flag !== '--deploy' && flag !== '--dry-run')) {
      throw new Error('Usage: pnpm publish:site:hashtree [--dry-run] or pnpm deploy:site [--dry-run]');
    }
    const result = await runSiteRelease({ deploy: flags.has('--deploy'), dryRun: flags.has('--dry-run') });
    if (result.steps) {
      for (const step of result.steps) console.log(`${step.label}: ${step.command.join(' ')}`);
    } else {
      console.log(`Website published: htree://${result.publish.publishedRef}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
