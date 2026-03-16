import puppeteer from 'puppeteer';
import pLimit from 'p-limit';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { normalizeUrl, isInternalUrl, urlToFilePath, saveFile, ensureDir, Logger, isAssetUrl } from './utils.js';
import { AssetDownloader } from './asset-downloader.js';
import { UrlRewriter } from './url-rewriter.js';

/**
 * Core crawler that orchestrates page discovery, content capture,
 * asset downloading, and URL rewriting.
 */
export class Crawler {
  /**
   * @param {object} options
   * @param {string} options.url - Start URL
   * @param {string} options.outputDir - Output directory
   * @param {number} options.concurrency - Max parallel pages
   * @param {number} options.timeout - Navigation timeout in ms
   * @param {string} [options.userAgent] - Custom User-Agent string
   * @param {boolean} [options.noJs] - Disable JavaScript
   * @param {number} [options.maxDepth] - Maximum crawl depth (Infinity = unlimited)
   * @param {boolean} [options.verbose] - Verbose logging
   * @param {boolean} [options.show] - Show browser window (non-headless)
   */
  constructor(options) {
    this.startUrl = options.url;
    this.outputDir = options.outputDir.replace(/\\/g, '/');
    this.concurrency = options.concurrency || 1;
    this.timeout = options.timeout || 30000;
    this.userAgent = options.userAgent || null;
    this.noJs = options.noJs || false;
    this.maxDepth = options.maxDepth ?? Infinity;
    this.verbose = options.verbose || false;
    this.show = options.show || false;
    this.resume = options.resume || false;

    const parsedStart = new URL(this.startUrl);
    this.origin = parsedStart.origin;

    this.logger = new Logger(this.verbose);

    /** @type {Map<string, number>} URL → depth it was discovered at */
    this.visited = new Map();

    /** @type {Array<{url: string, depth: number}>} */
    this.queue = [];

    /** @type {Map<string, string>} absoluteUrl → local file path (relative to outputDir) */
    this.pageMap = new Map();

    /** @type {Map<string, string>} original HTML content keyed by local file path */
    this.rawPages = new Map();

    /** @type {AssetDownloader} */
    this.assetDownloader = new AssetDownloader(this.origin, this.outputDir, this.logger);

    /** @type {Array<{from: string, to: string}>} */
    this.redirects = [];

    /** @type {Array<{url: string, depth: number}>} */
    this.failedPages = [];
  }

  /**
   * Run the full crawl process.
   */
  async run() {
    this.logger.info(`Starting crawl of ${this.startUrl}`);
    this.logger.info(`Output directory: ${this.outputDir}`);
    this.logger.info(`Concurrency: ${this.concurrency}`);
    if (this.maxDepth !== Infinity) {
      this.logger.info(`Max depth: ${this.maxDepth}`);
    }
    if (this.show) {
      this.logger.info('Browser: visible (non-headless)');
    }

    const browser = await puppeteer.launch({
      headless: !this.show,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      let stateLoaded = false;
      if (this.resume) {
        stateLoaded = await this._loadState();
      }

      // Phase 1: Crawl all pages
      if (!stateLoaded || this.queue.length > 0 || this.failedPages.length > 0) {
        this.logger.info('--- Phase 1: Crawling pages ---');
        await this._crawlPages(browser);
      } else {
        this.logger.info('--- Phase 1: Crawling pages (Already completed) ---');
      }

      // Phase 2: Rewrite URLs in all saved content
      this.logger.info('--- Phase 2: Rewriting URLs ---');
      await this._rewriteAll();

      // Phase 3: Generate redirect files (.htaccess, PHP, JS)
      this.logger.info('--- Phase 3: Generating redirects ---');
      await this._generateRedirects();

      if (this.failedPages.length === 0) {
        await this._clearState();
      } else {
        this.logger.warn(`There are ${this.failedPages.length} permanently failed pages. State file preserved. Use --resume to try again later.`);
        await this._saveState(); // Ensure last state is saved
      }

      this.logger.success(`Crawl complete! ${this.pageMap.size} pages, ${this.assetDownloader.getAssetMap().size} assets, ${this.redirects.length} redirect(s) saved.`);
      this.logger.info(`Output: ${this.outputDir}`);
    } finally {
      try {
        await browser.close();
      } catch (err) {
        this.logger.debug(`Browser close error: ${err.message}`);
      }
    }
  }

  /**
   * Crawl pages using a BFS queue with concurrency limit.
   */
  async _crawlPages(browser) {
    const limit = pLimit(this.concurrency);

    // Only initialize start URL if we haven't visited anything (e.g. not resuming)
    if (this.visited.size === 0) {
      const normalized = normalizeUrl(this.startUrl, this.origin);
      this.queue.push({ url: normalized, depth: 0 });
      this.visited.set(normalized, 0);
    }

    let hasRetried = false;

    while (this.queue.length > 0 || (!hasRetried && this.failedPages.length > 0)) {
      if (this.queue.length === 0 && !hasRetried && this.failedPages.length > 0) {
        this.logger.info(`--- Phase 1.5: Retrying ${this.failedPages.length} failed page(s) ---`);
        this.queue = this.failedPages.map(page => ({ ...page, isRetry: true }));
        this.failedPages = [];
        hasRetried = true;
      }

      const batch = this.queue.splice(0, this.concurrency);
      const promises = batch.map(({ url, depth, isRetry = false }) =>
        limit(() => this._processPage(browser, url, depth, isRetry))
      );
      await Promise.all(promises);

      // Save state after each batch completes
      await this._saveState();
    }
  }

  /**
   * Performs a fast HTTP HEAD request to determine if the URL returns HTML.
   * If it returns a file download (like a PDF or ZIP from a PHP script),
   * we skip processing it in Puppeteer to avoid 'Navigating frame was detached' crashes.
   */
  async _checkIfHtml(urlStr) {
    return new Promise((resolve) => {
      try {
        const parsed = new URL(urlStr);
        const protocol = parsed.protocol === 'https:' ? https : http;
        const req = protocol.request(urlStr, { method: 'HEAD', timeout: 5000 }, (res) => {
          const contentType = (res.headers['content-type'] || '').toLowerCase();
          const contentDisposition = (res.headers['content-disposition'] || '').toLowerCase();

          if (contentDisposition.includes('attachment')) {
            resolve(false);
          } else if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
            resolve(false); // E.g., application/pdf, image/jpeg
          } else {
            resolve(true);
          }
          req.destroy();
        });

        req.on('error', () => resolve(true)); // On error, assume true to let Puppeteer try and handle it legitimately
        req.on('timeout', () => { req.destroy(); resolve(true); });
        req.end();
      } catch {
        resolve(true);
      }
    });
  }

  /**
   * Process a single page: navigate, capture HTML, discover links and assets.
   * Detects server-side redirects and creates redirect stubs instead of duplicating HTML.
   */
  async _processPage(browser, url, depth, isRetry = false) {
    if (isAssetUrl(url)) {
      this.logger.debug(`[Asset Routing] Downloading media instead of crawling: ${url}`);
      await this.assetDownloader.downloadMany([url]);
      return;
    }

    const prefix = isRetry ? '[RETRY]' : `[depth=${depth}]`;
    this.logger.info(`${prefix} Crawling: ${url}`);

    let page;
    try {
      page = await browser.newPage();
    } catch (err) {
      this.logger.error(`Failed to open new page for ${url}: ${err.message}`);
      if (!isRetry) this.failedPages.push({ url, depth });
      return;
    }

    try {
      if (this.userAgent) {
        await page.setUserAgent(this.userAgent);
      }
      if (this.noJs) {
        await page.setJavaScriptEnabled(false);
      }

      // Use CDP to deny file downloads — prevents Chrome from detaching the
      // navigation frame when it encounters Content-Disposition: attachment
      // or non-HTML content types (like PDFs served by PHP scripts).
      const cdp = await page.createCDPSession();
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });

      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        if (['media', 'websocket'].includes(type)) {
          req.abort().catch(e => this.logger.debug(`Request abort error: ${e.message}`));
        } else {
          req.continue().catch(e => this.logger.debug(`Request continue error: ${e.message}`));
        }
      });

      try {
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: this.timeout,
        });
      } catch (navErr) {
        const msg = navErr.message || '';
        // "Navigating frame was detached" means Chrome tried to download a file.
        // Route to AssetDownloader as a direct HTTP download instead of retrying in Puppeteer.
        if (msg.includes('frame was detached') || msg.includes('net::ERR_ABORTED')) {
          this.logger.info(`[Download detected] ${url} triggered a file download, routing to asset downloader`);
          await this.assetDownloader.downloadMany([url]);
          return;
        }
        this.logger.warn(`Navigation failed for ${url}: ${msg}`);
        this.failedPages.push({ url, depth });
        return; // Skip this page
      }

      // Check if the page redirected to a different URL
      const finalUrl = normalizeUrl(page.url(), this.origin);

      if (finalUrl && finalUrl !== url) {
        // This was a redirect — don't store HTML, create a redirect instead
        this.logger.info(`  ↳ Redirect detected: ${url} → ${finalUrl}`);

        const { filePath: fromFilePath } = urlToFilePath(url, this.outputDir);
        const { filePath: toFilePath } = urlToFilePath(finalUrl, this.outputDir);

        // Record the redirect
        const fromParsed = new URL(url);
        const toParsed = new URL(finalUrl);
        this.redirects.push({
          from: fromParsed.pathname + fromParsed.search,
          to: '/' + toFilePath,
        });

        // Map the original URL to its redirect target's file path
        // so URL rewriting resolves links to this URL correctly
        this.pageMap.set(url, toFilePath);

        // Make sure the redirect target is in the queue
        if (!this.visited.has(finalUrl) && isInternalUrl(finalUrl, this.origin)) {
          this.visited.set(finalUrl, depth);
          this.queue.push({ url: finalUrl, depth });
        }

        // Still extract links from this page so we don't miss anything
        const { links, assets } = await this._extractUrlsFromPage(page, finalUrl);
        await this.assetDownloader.downloadMany(assets);

        if (depth < this.maxDepth) {
          for (const link of links) {
            const norm = normalizeUrl(link, this.origin);
            if (norm && !this.visited.has(norm) && isInternalUrl(norm, this.origin)) {
              this.visited.set(norm, depth + 1);
              this.queue.push({ url: norm, depth: depth + 1 });
            }
          }
        }

        return; // Don't save HTML for redirect sources
      }

      // Wait a tiny bit for any lazy-loaded content
      await page.evaluate(() => new Promise(r => setTimeout(r, 500)));

      // Get the fully rendered HTML
      const html = await page.content();

      // Compute local file path
      const { filePath, fullPath, redirectFrom } = urlToFilePath(url, this.outputDir);
      this.pageMap.set(url, filePath);
      this.rawPages.set(filePath, html);

      // Track redirect if query params were sanitized
      if (redirectFrom) {
        this.redirects.push({ from: redirectFrom, to: '/' + filePath });
      }

      // Save raw HTML (will be rewritten later)
      await saveFile(fullPath, html);

      // Discover links and assets from the page
      const { links, assets } = await this._extractUrlsFromPage(page, url);

      // Download all discovered assets
      await this.assetDownloader.downloadMany(assets);

      // Enqueue discovered internal links
      if (depth < this.maxDepth) {
        const foundAssets = [];
        for (const link of links) {
          const norm = normalizeUrl(link, this.origin);
          if (norm && !this.visited.has(norm) && isInternalUrl(norm, this.origin)) {
            this.visited.set(norm, depth + 1);
            if (isAssetUrl(norm)) {
              foundAssets.push(norm);
            } else {
              this.queue.push({ url: norm, depth: depth + 1 });
            }
          }
        }
        if (foundAssets.length > 0) {
          await this.assetDownloader.downloadMany(foundAssets);
        }
      }
    } catch (err) {
      this.logger.error(`Failed to process ${url}: ${err.message}`);
      if (!isRetry) this.failedPages.push({ url, depth });
    } finally {
      try {
        if (!page.isClosed()) {
          await page.close().catch(e => this.logger.debug(`Page close error: ${e.message}`));
        }
      } catch (e) {
        this.logger.debug(`Page close error: ${e.message}`);
      }
    }
  }

  /**
   * Extract all internal links and asset URLs from a page.
   */
  async _extractUrlsFromPage(page, pageUrl) {
    return page.evaluate((origin) => {
      const links = new Set();
      const assets = new Set();

      // Internal links via <a href>
      document.querySelectorAll('a[href]').forEach(a => {
        const href = new URL(a.href, document.baseURI).href;
        if (href.startsWith(origin)) {
          links.add(href);
        }
      });

      // CSS stylesheets
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
        assets.add(new URL(link.href, document.baseURI).href);
      });

      // Scripts
      document.querySelectorAll('script[src]').forEach(script => {
        assets.add(new URL(script.src, document.baseURI).href);
      });

      // Images
      document.querySelectorAll('img[src]').forEach(img => {
        assets.add(new URL(img.src, document.baseURI).href);
      });

      // img srcset
      document.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(entry => {
            const url = entry.trim().split(/\s+/)[0];
            assets.add(new URL(url, document.baseURI).href);
          });
        }
      });

      // Picture source
      document.querySelectorAll('source[src]').forEach(source => {
        assets.add(new URL(source.src, document.baseURI).href);
      });

      // Favicon
      document.querySelectorAll('link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]').forEach(link => {
        assets.add(new URL(link.href, document.baseURI).href);
      });

      // Open Graph / meta images
      document.querySelectorAll('meta[property="og:image"][content], meta[name="twitter:image"][content]').forEach(meta => {
        assets.add(new URL(meta.content, document.baseURI).href);
      });

      // Video poster
      document.querySelectorAll('video[poster]').forEach(video => {
        assets.add(new URL(video.poster, document.baseURI).href);
      });

      // Preloaded resources
      document.querySelectorAll('link[rel="preload"][href]').forEach(link => {
        assets.add(new URL(link.href, document.baseURI).href);
      });

      return {
        links: Array.from(links),
        assets: Array.from(assets)
      };
    }, this.origin);
  }

  /**
   * Rewrite all URLs in saved pages and CSS assets.
   */
  async _rewriteAll() {
    const rewriter = new UrlRewriter(
      this.origin,
      this.outputDir,
      this.assetDownloader.getAssetMap(),
      this.pageMap,
      this.logger
    );

    // Rewrite HTML pages
    for (const [pageUrl, filePath] of this.pageMap) {
      const fullPath = this.outputDir + '/' + filePath;
      try {
        const rawHtml = this.rawPages.get(filePath) || await readFile(fullPath, 'utf-8');
        const rewritten = rewriter.rewriteHtml(rawHtml, filePath, pageUrl);
        await saveFile(fullPath, rewritten);
        this.logger.debug(`Rewrote: ${filePath}`);
      } catch (err) {
        this.logger.error(`Failed to rewrite ${filePath}: ${err.message}`);
      }
    }

    // Rewrite CSS files
    for (const [assetUrl, filePath] of this.assetDownloader.getAssetMap()) {
      if (filePath.endsWith('.css')) {
        const fullPath = this.outputDir + '/' + filePath;
        await rewriter.rewriteCssFile(fullPath, assetUrl);
        this.logger.debug(`Rewrote CSS: ${filePath}`);
      }
    }
  }

  /**
   * Generate redirect files: .htaccess (Apache), redirect.php (PHP fallback),
   * and a small JS redirect snippet embedded in an HTML stub for each redirect source.
   */
  async _generateRedirects() {
    if (this.redirects.length === 0) {
      this.logger.info('No redirects needed.');
      return;
    }

    // --- .htaccess (Apache mod_rewrite) ---
    const htaccessLines = [
      '# Generated by Statify',
      '# 301 Redirects for server-side redirects and query-parameter URLs',
      'RewriteEngine On',
      '',
    ];

    for (const { from, to } of this.redirects) {
      const fromUrl = new URL(from, this.origin);
      const path = fromUrl.pathname;
      const query = fromUrl.search ? fromUrl.search.slice(1) : '';

      htaccessLines.push(`# ${from} -> ${to}`);
      if (query) {
        htaccessLines.push(`RewriteCond %{QUERY_STRING} ^${this._escapeRegex(query)}$`);
        htaccessLines.push(`RewriteRule ^${this._escapeRegex(path.slice(1))}$ ${to}? [R=301,L]`);
      } else {
        // Simple path redirect (no query string)
        let fromPattern = path.slice(1); // remove leading /
        if (!fromPattern) fromPattern = '^$'; // root
        else fromPattern = '^' + this._escapeRegex(fromPattern) + '$';
        htaccessLines.push(`RewriteRule ${fromPattern} ${to} [R=301,L]`);
      }
      htaccessLines.push('');
    }

    const htaccessPath = this.outputDir + '/.htaccess';
    await saveFile(htaccessPath, htaccessLines.join('\n'));
    this.logger.success(`Generated .htaccess with ${this.redirects.length} redirect(s).`);

    // --- index.php (PHP fallback) ---
    const phpLines = [
      '<?php',
      '// Generated by Statify - PHP redirect fallback',
      '$redirects = [',
    ];

    for (const { from, to } of this.redirects) {
      phpLines.push(`    '${this._escapePhp(from)}' => '${this._escapePhp(to)}',`);
    }

    phpLines.push(
      '];',
      '',
      '$uri = rtrim($_SERVER["REQUEST_URI"], "/") ?: "/";',
      '$target = $redirects[$_SERVER["REQUEST_URI"]] ?? $redirects[$uri] ?? null;',
      'if ($target) {',
      '    header("HTTP/1.1 301 Moved Permanently");',
      '    header("Location: $target");',
      '    exit;',
      '}',
      '?>',
    );

    const phpPath = this.outputDir + '/index.php';
    await saveFile(phpPath, phpLines.join('\n'));
    this.logger.success(`Generated index.php with ${this.redirects.length} redirect(s).`);

    // --- HTML stub files with JS redirect (client-side fallback) ---
    for (const { from, to } of this.redirects) {
      const { filePath, fullPath } = urlToFilePath(this.origin + from, this.outputDir);

      // Only create JS redirect stub if there's no real page saved at this path
      if (!this.rawPages.has(filePath)) {
        const htmlStub = [
          '<!DOCTYPE html>',
          '<html>',
          '<head>',
          `  <meta http-equiv="refresh" content="0;url=${to}">`,
          `  <link rel="canonical" href="${to}">`,
          '  <title>Redirecting...</title>',
          '</head>',
          '<body>',
          `  <p>Redirecting to <a href="${to}">${to}</a>...</p>`,
          '  <script>',
          `    window.location.replace("${to}");`,
          '  </script>',
          '</body>',
          '</html>',
        ].join('\n');

        await saveFile(fullPath, htmlStub);
        this.logger.debug(`Created JS redirect stub: ${filePath}`);
      }
    }

    this.logger.success(`Generated HTML redirect stubs as JS fallback.`);
  }

  /**
   * Escape special regex characters in a string.
   */
  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Escape a string for use in PHP single-quoted strings.
   */
  _escapePhp(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /**
   * Save the current state to a JSON file to allow resuming.
   */
  async _saveState() {
    try {
      const stateFile = this.outputDir + '/.statify-state.json';
      const state = {
        queue: this.queue,
        visited: Array.from(this.visited.entries()),
        pageMap: Array.from(this.pageMap.entries()),
        redirects: this.redirects,
        failedPages: this.failedPages,
        downloadedAssets: Array.from(this.assetDownloader.getAssetMap().entries())
      };
      await saveFile(stateFile, JSON.stringify(state));
    } catch (e) {
      this.logger.debug(`Failed to save state: ${e.message}`);
    }
  }

  /**
   * Load state from JSON file if it exists.
   */
  async _loadState() {
    try {
      const stateFile = this.outputDir + '/.statify-state.json';
      if (!existsSync(stateFile)) {
        this.logger.warn('State file not found. Starting fresh crawl.');
        return false;
      }

      const data = await readFile(stateFile, 'utf-8');
      const state = JSON.parse(data);

      this.queue = state.queue || [];
      this.visited = new Map(state.visited || []);
      this.pageMap = new Map(state.pageMap || []);
      this.redirects = state.redirects || [];
      this.failedPages = state.failedPages || [];

      if (state.downloadedAssets) {
        this.assetDownloader.setAssetMap(new Map(state.downloadedAssets));
      }

      this.logger.info(`Resumed state: ${this.visited.size} pages visited, ${this.queue.length} left in queue. Assets: ${this.assetDownloader.getAssetMap().size}.`);
      return true;
    } catch (e) {
      this.logger.error(`Error loading state: ${e.message}. Starting fresh crawl.`);
      return false;
    }
  }

  /**
   * Clear the state file when the crawl successfully finishes.
   */
  async _clearState() {
    try {
      const stateFile = this.outputDir + '/.statify-state.json';
      if (existsSync(stateFile)) {
        await unlink(stateFile);
      }
    } catch (e) {
      this.logger.debug(`Failed to clear state file: ${e.message}`);
    }
  }
}
