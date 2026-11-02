#!/usr/bin/env node
'use strict';

require('../src/supervisor').main(process.argv.slice(2)).catch((error) => {
  console.error(`devloop-supervisor: ${error.stack || error}`);
  process.exit(1);
});
