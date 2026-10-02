const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const requiredSecrets = [
  'ACCESS_TOKEN',
  'ADMIN_TOKEN',
  'DEEPSEEK_API_KEY',
];

const missingSecrets = requiredSecrets.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.trim() === '';
});

if (missingSecrets.length > 0) {
  console.error(
    `Cloudflare Build variables are missing: ${missingSecrets.join(', ')}`,
  );
  process.exit(1);
}

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'operhelper-secrets-'),
);
const secretsFile = path.join(temporaryDirectory, 'runtime-secrets.json');

try {
  const secrets = Object.fromEntries(
    requiredSecrets.map((name) => [name, process.env[name]]),
  );

  fs.writeFileSync(secretsFile, JSON.stringify(secrets), {
    encoding: 'utf8',
    mode: 0o600,
  });

  const wranglerArguments = [
    'deploy',
    '--secrets-file',
    secretsFile,
    '--keep-vars',
  ];

  if (process.env.WRANGLER_DRY_RUN === '1') {
    wranglerArguments.push('--dry-run');
  }

  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable
    ? process.execPath
    : process.platform === 'win32'
      ? 'npx.cmd'
      : 'npx';
  const commandArguments = npmExecutable
    ? [npmExecutable, 'exec', '--', 'wrangler', ...wranglerArguments]
    : ['wrangler', ...wranglerArguments];

  const result = spawnSync(command, commandArguments, {
    stdio: 'inherit',
    shell: !npmExecutable && process.platform === 'win32',
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
