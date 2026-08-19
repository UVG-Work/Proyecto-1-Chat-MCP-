/**
 * Prepares the sandbox used by the requirement 4 demonstration.
 *
 * Creates sandbox/demo-repo as an initialised git repository.
 *
 * Why this exists: the official Git MCP server (mcp-server-git 1.29.0) exposes
 * twelve tools - status, diff, commit, add, reset, log, branch, checkout, show -
 * but no git_init. Repository creation therefore cannot be driven through MCP
 * with the current official server, so it is done here instead. Everything the
 * project statement asks for after that (create a README, add it to the
 * repository, commit) IS performed by the chatbot through MCP.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = resolve(repoRoot, 'sandbox');
const demoRepo = resolve(sandbox, 'demo-repo');

const reset = process.argv.includes('--reset');

if (reset && existsSync(demoRepo)) {
  rmSync(demoRepo, { recursive: true, force: true });
  console.log(`removed ${demoRepo}`);
}

mkdirSync(demoRepo, { recursive: true });

if (existsSync(resolve(demoRepo, '.git'))) {
  console.log(`${demoRepo} is already a git repository`);
} else {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: demoRepo, stdio: 'inherit' });
  // A repository with no identity configured refuses commits, and the demo
  // commits through the MCP server rather than through a shell.
  execFileSync('git', ['config', 'user.name', 'MCP Chat Host'], { cwd: demoRepo });
  execFileSync('git', ['config', 'user.email', 'mcp-host@example.invalid'], { cwd: demoRepo });
  console.log(`initialised git repository at ${demoRepo}`);
}

console.log('\nSandbox ready. Try asking the chatbot:');
console.log(
  '  Create a README.md in the demo-repo folder describing this project, add it to the\n' +
    '  git repository and commit it with a descriptive message. Then show me the git log.',
);
