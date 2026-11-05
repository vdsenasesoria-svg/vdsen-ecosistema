'use strict';
const path = require('node:path');
module.exports = async function* (source) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      if (d.details?.error?.failureType === 'subtestsFailed') continue; // Children supply exact identities.
      const record = {
        file: path.relative(process.cwd(), d.file || '').replace(/\\/g, '/'),
        name: d.name,
        status: event.type === 'test:pass' ? (d.skip || d.todo ? 'SKIP' : 'PASS') : (d.details?.error?.failureType === 'cancelledByParent' || d.details?.error?.failureType === 'testTimeoutFailure' ? 'CANCELLED' : 'FAIL')
      };
      yield 'VDSEN_TEST_EVENT ' + JSON.stringify(record) + '\n';
    }
  }
};
