"""Fixed offline cache population and ci, executed only as the isolated job user."""
import pathlib
import subprocess
import sys

node = '/opt/node-v22.23.4-linux-arm64/bin/node'
npm = '/opt/node-v22.23.4-linux-arm64/lib/node_modules/npm/bin/npm-cli.js'
for file in sorted(pathlib.Path('/packages').glob('*.tgz')):
    subprocess.run([node, npm, 'cache', 'add', str(file), '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
raise SystemExit(subprocess.run([node, npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']).returncode)
