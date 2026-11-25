#!/usr/bin/env node
// Thin observable wrapper: all CI monitoring keeps an explicit repository.
const {spawnSync} = require('node:child_process');
const [command, ...args] = process.argv.slice(2);
const repo = process.env.GH_REPO || 'HyperCactus/knightlight';
const commands = {
  runs: ['run', 'list', '--repo', repo, '--limit', '10', ...args],
  watch: ['run', 'watch', args[0], '--repo', repo, '--exit-status', '--interval', '15'],
  'log-failed': ['run', 'view', args[0], '--repo', repo, '--log-failed'],
  view: ['run', 'view', args[0], '--repo', repo, '--json', 'status,conclusion,jobs,url'],
};
if (!commands[command]) {
  console.log('Usage: node scripts/ci_monitor.cjs runs | view RUN | watch RUN | log-failed RUN\nSet GH_BIN to select a GitHub CLI installation; GH_REPO overrides the repository.');
  process.exit(command === '--help' ? 0 : 1);
}
console.log(`GitHub Actions: ${command} (${repo})`);
const r = spawnSync(process.env.GH_BIN || 'gh', commands[command], {stdio: 'inherit'});
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
