#!/usr/bin/env node

/**
 * repeat-crawl.js
 *
 * Repeatedly runs statify with the given arguments until no pages remain.
 * Between each run, waits a configurable delay (default: 5 minutes) to
 * help evade rate-limiting / spam protection.
 *
 * Usage:
 *   node tools/repeat-crawl.js [url] [statify-options...]
 *
 * Example:
 *   node tools/repeat-crawl.js http://domain.com -s -r -l 90
 *
 * Options specific to this tool (place BEFORE the url):
 *   --delay <minutes>   Delay between runs in minutes (default: 5)
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Parse our own --delay flag, pass everything else through to statify ──
const args = process.argv.slice(2);
let delayMinutes = 5;

const delayIdx = args.indexOf('--delay');
if (delayIdx !== -1 && args[delayIdx + 1]) {
  delayMinutes = parseFloat(args[delayIdx + 1]);
  args.splice(delayIdx, 2);
}

if (args.length === 0) {
  console.error('Usage: node tools/repeat-crawl.js [--delay <minutes>] <url> [statify-options...]');
  console.error('Example: node tools/repeat-crawl.js https://example.com -s -r -l 90');
  process.exit(1);
}

// Ensure --resume is present (required for repeated crawling)
if (!args.includes('-r') && !args.includes('--resume')) {
  console.log('[repeat-crawl] Adding --resume flag (required for repeated crawling).');
  args.push('-r');
}

const statifyBin = resolve(__dirname, '..', 'bin', 'statify.js');
const delayMs = delayMinutes * 60 * 1000;

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run statify once and capture its output.
 * Returns an object with { exitCode, pagesRemaining }.
 * pagesRemaining is the number parsed from the "X page(s) remaining" message,
 * or null if the message wasn't found (indicating the crawl finished naturally).
 */
function runStatify() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [statifyBin, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    let pagesRemaining = null;
    let setPagesRemaining = (text) => {
      // Look for the "X page(s) remaining" message
      const match = text.match(/\s(\d+)\s+page\(s\)\s+remaining/);
      if (match) {
        pagesRemaining = parseInt(match[1], 10);
      }
    }

    child.stdout.on('data', (data) => {
      const text = data.toString();
      setPagesRemaining(text);
      process.stdout.write(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      setPagesRemaining(text);
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, pagesRemaining });
    });

    child.on('error', (err) => {
      console.error(`[repeat-crawl] Failed to start statify: ${err.message}`);
      resolve({ exitCode: 1, pagesRemaining: null });
    });
  });
}

// ── Main loop ──
async function main() {
  let iteration = 0;

  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║               repeat-crawl — Statify Runner            ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log(`║  URL:   ${args[0].padEnd(47)}║`);
  console.log(`║  Delay: ${(delayMinutes + ' min between runs').padEnd(47)}║`);
  console.log(`║  Args:  ${args.slice(1).join(' ').padEnd(47)}║`);
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log();

  while (true) {
    iteration++;
    const startTime = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  🔄 Run #${iteration}  —  ${new Date().toLocaleString()}`);
    console.log(`${'─'.repeat(60)}\n`);

    const { exitCode, pagesRemaining } = await runStatify();
    const elapsed = Date.now() - startTime;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ✓ Run #${iteration} finished in ${formatDuration(elapsed)} (exit code ${exitCode})`);

    if (exitCode !== 0) {
      console.log(`  ⚠ Statify exited with code ${exitCode}.`);
      console.log(`  Waiting ${delayMinutes} min before retrying...`);
      console.log(`${'─'.repeat(60)}\n`);
      await sleep(delayMs);
      continue;
    }

    if (pagesRemaining === null || pagesRemaining === 0) {
      console.log(`  🎉 No pages remaining — crawl is complete!`);
      console.log(`${'─'.repeat(60)}\n`);
      break;
    }

    console.log(`  📋 ${pagesRemaining} page(s) remaining.`);
    console.log(`  ⏳ Waiting ${delayMinutes} min before next run...`);
    console.log(`${'─'.repeat(60)}\n`);

    await sleep(delayMs);
  }

  console.log(`\n✅ All done after ${iteration} run(s).`);
}

main().catch((err) => {
  console.error(`[repeat-crawl] Fatal error: ${err.message}`);
  process.exit(1);
});
