import puppeteer from 'puppeteer';
import pLimit from 'p-limit';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { normalizeUrl, isInternalUrl, urlToFilePath, saveFile, ensureDir, Logger } from './utils.js';
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

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      // Phase 1: Crawl all pages
      this.logger.info('--- Phase 1: Crawling pages ---');
      await this._crawlPages(browser);

      // Phase 2: Rewrite URLs in all saved content
      this.logger.info('--- Phase 2: Rewriting URLs ---');
      await this._rewriteAll();

      // Phase 3: Generate .htaccess
      this.logger.info('--- Phase 3: Generating .htaccess ---');
      await this._generateHtaccess();

      this.logger.success(`Crawl complete! ${this.pageMap.size} pages, ${this.assetDownloader.getAssetMap().size} assets saved.`);
      this.logger.info(`Output: ${this.outputDir}`);
    } finally {
      await browser.close();
    }
  }

  /**
   * Crawl pages using a BFS queue with concurrency limit.
   */
  async _crawlPages(browser) {
    const limit = pLimit(this.concurrency);
    const normalized = normalizeUrl(this.startUrl, this.origin);
    this.queue.push({ url: normalized, depth: 0 });
    this.visited.set(normalized, 0);

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.concurrency);
      const promises = batch.map(({ url, depth }) =>
        limit(() => this._processPage(browser, url, depth))
      );
      await Promise.all(promises);
    }
  }

  /**
   * Process a single page: navigate, capture HTML, discover links and assets.
   */
  async _processPage(browser, url, depth) {
    this.logger.info(`[depth=${depth}] Crawling: ${url}`);
    const page = await browser.newPage();

    try {
      if (this.userAgent) {
        await page.setUserAgent(this.userAgent);
      }
      if (this.noJs) {
        await page.setJavaScriptEnabled(false);
      }

      // Block unnecessary resource types to speed up crawling
      // (we download assets separately)
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['media', 'websocket'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: this.timeout,
      });

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
        for (const link of links) {
          const norm = normalizeUrl(link, this.origin);
          if (norm && !this.visited.has(norm) && isInternalUrl(norm, this.origin)) {
            this.visited.set(norm, depth + 1);
            this.queue.push({ url: norm, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      this.logger.error(`Failed to process ${url}: ${err.message}`);
    } finally {
      await page.close();
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
        try {
          const href = new URL(a.href, document.baseURI).href;
          if (href.startsWith(origin)) {
            links.add(href);
          }
        } catch {}
      });

      // CSS stylesheets
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
        try {
          assets.add(new URL(link.href, document.baseURI).href);
        } catch {}
      });

      // Scripts
      document.querySelectorAll('script[src]').forEach(script => {
        try {
          assets.add(new URL(script.src, document.baseURI).href);
        } catch {}
      });

      // Images
      document.querySelectorAll('img[src]').forEach(img => {
        try {
          assets.add(new URL(img.src, document.baseURI).href);
        } catch {}
      });

      // img srcset
      document.querySelectorAll('img[srcset], source[srcset]').forEach(el => {
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(entry => {
            const url = entry.trim().split(/\s+/)[0];
            try {
              assets.add(new URL(url, document.baseURI).href);
            } catch {}
          });
        }
      });

      // Picture source
      document.querySelectorAll('source[src]').forEach(source => {
        try {
          assets.add(new URL(source.src, document.baseURI).href);
        } catch {}
      });

      // Favicon
      document.querySelectorAll('link[rel="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]').forEach(link => {
        try {
          assets.add(new URL(link.href, document.baseURI).href);
        } catch {}
      });

      // Open Graph / meta images
      document.querySelectorAll('meta[property="og:image"][content], meta[name="twitter:image"][content]').forEach(meta => {
        try {
          assets.add(new URL(meta.content, document.baseURI).href);
        } catch {}
      });

      // Video poster
      document.querySelectorAll('video[poster]').forEach(video => {
        try {
          assets.add(new URL(video.poster, document.baseURI).href);
        } catch {}
      });

      // Preloaded resources
      document.querySelectorAll('link[rel="preload"][href]').forEach(link => {
        try {
          assets.add(new URL(link.href, document.baseURI).href);
        } catch {}
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
   * Generate .htaccess with 301 redirects for query-parameter URLs.
   */
  async _generateHtaccess() {
    if (this.redirects.length === 0) {
      this.logger.info('No redirects needed.');
      return;
    }

    const lines = [
      '# Generated by Statify',
      '# 301 Redirects for URLs with query parameters',
      'RewriteEngine On',
      '',
    ];

    for (const { from, to } of this.redirects) {
      // Parse the "from" URL to extract path and query
      const fromUrl = new URL(from, this.origin);
      const path = fromUrl.pathname;
      const query = fromUrl.search.slice(1); // remove leading ?

      // Use RewriteCond to match query string and RewriteRule for path
      lines.push(`# ${from} -> ${to}`);
      lines.push(`RewriteCond %{QUERY_STRING} ^${this._escapeRegex(query)}$`);
      lines.push(`RewriteRule ^${this._escapeRegex(path.slice(1))}$ ${to}? [R=301,L]`);
      lines.push('');
    }

    const htaccessPath = this.outputDir + '/.htaccess';
    await saveFile(htaccessPath, lines.join('\n'));
    this.logger.success(`Generated .htaccess with ${this.redirects.length} redirect(s).`);
  }

  /**
   * Escape special regex characters in a string.
   */
  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
