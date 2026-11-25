#!/usr/bin/env node
// Thin observable wrapper: all CI monitoring keeps an explicit repository.
const {spawnSync} = require('node:child_process');
const [command, ...args] = process.argv.slice(2);
const repo = process.env.GH_REPO || 'HyperCactus/knightlight';
const commands = {
  cancel: ['run', 'cancel', args[0], '--repo', repo],
  runs: ['run', 'list', '--repo', repo, '--limit', '10', ...args],
  watch: ['run', 'watch', args[0], '--repo', repo, '--exit-status', '--interval', '15'],
  'job-log': ['api', `repos/${repo}/actions/jobs/${args[0]}/logs`, '--allow-escape-sequences'],
  'log-failed': ['run', 'view', args[0], '--repo', repo, '--log-failed'],
  view: ['run', 'view', args[0], '--repo', repo, '--json', 'status,conclusion,jobs,url'],
};
if (command === 'cleanup-installers') {
  if (!/^\d+$/.test(args[0] || '')) throw Error('Expected workflow run ID');
  const gh = process.env.GH_BIN || 'gh';
  const listing = spawnSync(gh, ['api', `repos/${repo}/actions/runs/${args[0]}/artifacts`], {encoding: 'utf8'});
  if (listing.status !== 0) { process.stderr.write(listing.stderr || 'Artifact listing failed'); process.exit(1); }
  for (const artifact of JSON.parse(listing.stdout).artifacts) {
    if (!artifact.name.startsWith('Knightlight-') || artifact.name === 'Knightlight-opponent-model') continue;
    console.log(`Remove temporary installer artifact: ${artifact.name}`);
    const result = spawnSync(gh, ['api', '-X', 'DELETE', `repos/${repo}/actions/artifacts/${artifact.id}`], {stdio: 'inherit'});
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.exit(0);
}
if (!commands[command]) {
  console.log('Usage: node scripts/ci_monitor.cjs runs | view RUN | watch RUN | log-failed RUN | job-log JOB | cancel RUN | cleanup-installers RUN\nSet GH_BIN to select a GitHub CLI installation; GH_REPO overrides the repository.');
  process.exit(command === '--help' ? 0 : 1);
}
console.log(`GitHub Actions: ${command} (${repo})`);
const r = spawnSync(process.env.GH_BIN || 'gh', commands[command], {stdio: command === 'job-log' ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 50 * 1024 * 1024});
if (command === 'job-log') {
  const clean = s => (s || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  process.stdout.write(clean(r.stdout));
  process.stderr.write(clean(r.stderr));
}
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
