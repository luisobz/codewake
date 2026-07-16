#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`agent-resume: ${error.message}`);
  process.exitCode = 1;
});
