#!/usr/bin/env node
// Node 22 flags node:sqlite as experimental; hide that one warning so CLI output stays clean.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) =>
  /SQLite/.test(String(warning?.message ?? warning)) ? undefined : emitWarning.call(process, warning, ...rest);

const { main } = await import('../src/cli.js');
try {
  main();
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
