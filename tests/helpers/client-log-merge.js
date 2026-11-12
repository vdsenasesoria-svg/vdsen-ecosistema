'use strict';
// T593-R: the per-entry merge helpers of vdsen-cliente.html (extracted from the real source) for the sandboxes that run the real _doSaveLogs.
const fs = require('node:fs');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '..', '..', 'vdsen-cliente.html'), 'utf8');
function extract(decl) { const start = client.indexOf(decl), b = client.indexOf('{', start); let d = 0; if (start < 0) throw new Error(decl); for (let i = b; i < client.length; i++) { d += (client[i] === '{') - (client[i] === '}'); if (!d) return client.slice(start, i + 1); } throw new Error(decl); }
const NAMES = ['_cloneJ', '_deepEq', '_hasKey', '_logsMirrorDiverged', '_noSts', '_mapDiff', '_setBaselines', '_resetLogsConcurrencyState', '_applyDiffToBaseline', '_commitSentToBaseline', '_overlayDirty', '_journalLogConflicts', '_adoptRemoteLogs', '_remoteHasNews', '_buildMergeWrite'];
const MERGE_HELPERS_SRC = 'var _logsBaseline = null, _unitsBaseline = null, _histBaseline = null, _logsHeal = true, _remoteWeekSeen = 0;\n' + NAMES.map((n) => extract('function ' + n + '(')).join('\n');
// SDK symbols a sandboxed FB needs for the field-path merge write
function FieldPath() { this.segments = Array.prototype.slice.call(arguments); }
const DELETE = { __delete: true };
const withMergeSdk = (fb) => Object.assign(fb, { FieldPath, deleteField: () => DELETE });
module.exports = { MERGE_HELPERS_SRC, withMergeSdk, FieldPath, DELETE };
// the same SDK symbols as source text, for the sandboxes built with new Function(...)
module.exports.FB_SDK_SRC = "function FieldPath() { this.segments = Array.prototype.slice.call(arguments); } var _DEL_SENTINEL = { __delete: true }; function deleteField() { return _DEL_SENTINEL; }";
