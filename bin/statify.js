#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { Crawler } from '../src/crawler.js';

const program = new Command();

program
  .name('statify')
  .description('Scrape a CMS-based website and generate a deployable static copy')
  .version('1.0.0')
  .argument('<url>', 'URL of the website to scrape (e.g. https://example.com)')
  .option('-o, --output <dir>', 'Output directory (default: domain name)')
  .option('-c, --concurrency <n>', 'Number of pages to crawl in parallel', parseInt, 1)
  .option('-t, --timeout <ms>', 'Navigation timeout per page in milliseconds', parseInt, 30000)
  .option('--user-agent <string>', 'Custom User-Agent string')
  .option('--no-js', 'Disable JavaScript rendering')
  .option('-r, --resume', 'Resume a previously interrupted crawl from .statify-state.json')
  .option('-s, --show', 'Show browser window (non-headless mode)')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (url, options) => {
    // Validate and normalize URL
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        console.error('Error: URL must use http or https protocol.');
        process.exit(1);
      }
      // Ensure trailing slash on bare domains
      if (!parsed.pathname || parsed.pathname === '/') {
        url = parsed.origin + '/';
      }
    } catch {
      console.error(`Error: Invalid URL "${url}". Please provide a valid URL (e.g. https://example.com).`);
      process.exit(1);
    }

    // Determine output directory
    let outputDir = options.output;
    if (!outputDir) {
      const parsed = new URL(url);
      outputDir = parsed.hostname;
    }
    outputDir = resolve(process.cwd(), outputDir);

    const crawler = new Crawler({
      url,
      outputDir,
      concurrency: options.concurrency,
      timeout: options.timeout,
      userAgent: options.userAgent,
      noJs: !options.js, // Commander's --no-js sets options.js = false
      maxDepth: options.maxDepth ?? Infinity,
      resume: options.resume || false,
      show: options.show,
      verbose: options.verbose,
    });

    try {
      await crawler.run();
    } catch (err) {
      console.error(`\nCrawl failed: ${err.message}`);
      if (options.verbose) {
        console.error(err.stack);
      }
      process.exit(1);
    }
  });

program.parse();
