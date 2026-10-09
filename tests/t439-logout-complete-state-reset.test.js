const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const client = fs.readFileSync('vdsen-cliente.html', 'utf8');
const start = client.indexOf('async function doLogout()');
assert.ok(start >= 0);
let depth = 0, end = client.indexOf('{', start);
for (; end < client.length; end++) {
  if (client[end] === '{') depth++;
  if (client[end] === '}' && --depth === 0) break;
}
const source = client.slice(start, end + 1);

test('T439: logout clears active plan, navigation, derived logs and pending client timers', () => {
  for (const statement of [
    'ACTIVE_PLAN_ID = null', 'DIA_ACTIVO = 0', 'EJ_ACTIVO = 0', '_EJERCICIOS_DIA = []',
    'LOGS_BY_WEEK = { log: {}, progrec: {} }', '_weeksExpanded = false',
    'clearTimeout(_saveLogsTimer)', 'clearTimeout(_ciAutoSaveTimer)',
    '_postSessionDi = null', '_preSelState = {}'
  ]) assert.ok(source.includes(statement), statement + ' must be reset during logout');
});
