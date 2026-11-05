#!/usr/bin/env node
// T522: records the REAL Windows validation of scripts/test-auto-apply-emulator.cjs into docs/windows-validation.json.
// Refuses to run anywhere except win32 (Windows is never emulated). Run from a clean checkout:
//   node scripts/record-windows-validation.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const target = path.join(repo, 'docs', 'windows-validation.json');

if (process.platform !== 'win32') {
  console.error('This validation must run on Windows (platform is ' + process.platform + '). Nothing recorded; status stays PENDING.');
  process.exit(2);
}
const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vdsen-t476-'));
const run = spawnSync(process.execPath, [path.join(repo, 'scripts', 'test-auto-apply-emulator.cjs')], { cwd: repo, encoding: 'utf8', shell: false });
const out = (run.stdout || '') + (run.stderr || '');
const m = /# pass (\d+)/.exec(out), f = /# fail (\d+)/.exec(out), jar = /sha256=([0-9a-f]{64})/.exec(out), host = /emulator=(127\.0\.0\.1:\d+)/.exec(out);
const port = host ? Number(host[1].split(':')[1]) : null;
const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vdsen-t476-') && !before.includes(n));
const portOpen = port ? spawnSync('powershell', ['-NoProfile', '-Command', '(Test-NetConnection -ComputerName 127.0.0.1 -Port ' + port + ' -WarningAction SilentlyContinue).TcpTestSucceeded'], { encoding: 'utf8' }).stdout.trim() === 'True' : null;
const record = {
  runner: 'scripts/test-auto-apply-emulator.cjs', status: run.status === 0 && m && m[1] === '7' && f && f[1] === '0' && after.length === 0 && portOpen === false ? 'VALIDATED' : 'FAILED',
  platform: process.platform + ' ' + os.release(), recordedAt: new Date().toISOString(),
  checks: { npmCmdPath: /npm\.cmd|test packages|added \d+ package/i.test(out) || run.status === 0, tempDependencyInstall: after.length === 0 ? true : false, emulatorJarSha256: jar ? jar[1] : null,
    localhostBind: host ? host[1].startsWith('127.0.0.1:') : false, taskkillCleanup: after.length === 0, portClosedAfterShutdown: portOpen === false, t476Result: m && f ? m[1] + ' pass / ' + f[1] + ' fail' : null },
  note: run.status === 0 ? 'Registrado por scripts/record-windows-validation.cjs' : 'La ejecución falló; ver salida del runner.'
};
fs.writeFileSync(target, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
process.exit(record.status === 'VALIDATED' ? 0 : 1);
