import * as cheerio from 'cheerio';
import { posix } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { urlToFilePath, normalizeUrl, isInternalUrl, sanitizeQueryString, Logger } from './utils.js';

/**
 * Rewrites all URLs in HTML and CSS content from absolute/root-relative
 * to proper relative paths within the static output directory.
 */
export class UrlRewriter {
  /**
   * @param {string} origin - The origin of the scraped site
   * @param {string} outputDir - Absolute path to output directory
   * @param {Map<string, string>} assetMap - Map of absolute URL → local file path (relative to outputDir)
   * @param {Map<string, string>} pageMap - Map of absolute URL → local file path (relative to outputDir)
   * @param {Logger} logger
   */
  constructor(origin, outputDir, assetMap, pageMap, logger) {
    this.origin = origin;
    this.outputDir = outputDir;
    this.assetMap = assetMap;
    this.pageMap = pageMap;
    this.logger = logger;
    /** @type {Array<{from: string, to: string}>} */
    this.redirects = [];
  }

  /**
   * Rewrite all URLs in an HTML string.
   * @param {string} html - The HTML content
   * @param {string} pageFilePath - The local file path of this page (relative to outputDir)
   * @param {string} pageUrl - The original absolute URL of this page
   * @returns {string} Rewritten HTML
   */
  rewriteHtml(html, pageFilePath, pageUrl) {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Ensure directory-like URLs end with '/' so relative URL resolution works correctly.
    // Without this, 'https://example.com/home' + 'stylesheets/style.css' resolves to
    // 'https://example.com/stylesheets/style.css' instead of
    // 'https://example.com/home/stylesheets/style.css'
    const baseUrl = this._ensureTrailingSlash(pageUrl);

    // Attributes that may contain URLs
    const urlAttributes = [
      { selector: '[href]', attr: 'href' },
      { selector: '[src]', attr: 'src' },
      { selector: '[action]', attr: 'action' },
      { selector: '[poster]', attr: 'poster' },
      { selector: '[data-src]', attr: 'data-src' },
      { selector: '[data-href]', attr: 'data-href' },
      { selector: '[data-background]', attr: 'data-background' },
    ];

    for (const { selector, attr } of urlAttributes) {
      $(selector).each((_, el) => {
        const val = $(el).attr(attr);
        if (!val || val.startsWith('data:') || val.startsWith('javascript:') || val.startsWith('mailto:') || val.startsWith('tel:') || val.startsWith('#')) {
          return;
        }

        const rewritten = this._resolveAndRewrite(val, baseUrl, pageFilePath);
        if (rewritten !== null) {
          $(el).attr(attr, rewritten);
        }
      });
    }

    // Handle srcset attributes (multiple URLs with descriptors)
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (!srcset) return;

      const rewritten = srcset.split(',').map(entry => {
        const parts = entry.trim().split(/\s+/);
        if (parts.length === 0) return entry;
        const url = parts[0];
        const descriptor = parts.slice(1).join(' ');
        const newUrl = this._resolveAndRewrite(url, baseUrl, pageFilePath);
        return (newUrl !== null ? newUrl : url) + (descriptor ? ' ' + descriptor : '');
      }).join(', ');

      $(el).attr('srcset', rewritten);
    });

    // Rewrite inline style url() references
    $('[style]').each((_, el) => {
      const style = $(el).attr('style');
      if (!style || !style.includes('url(')) return;

      const rewritten = this._rewriteCssUrls(style, baseUrl, pageFilePath);
      $(el).attr('style', rewritten);
    });

    // Rewrite <style> blocks
    $('style').each((_, el) => {
      const css = $(el).html();
      if (!css || !css.includes('url(')) return;
      $(el).html(this._rewriteCssUrls(css, baseUrl, pageFilePath));
    });

    let output = $.html();

    // Final catch-all: rewrite any remaining absolute URLs pointing to the origin.
    // This covers attributes not in the explicit list above (e.g. <option value="...">,
    // <input data-url="...">, custom data-* attributes), inline <script> content,
    // JSON-LD blocks, HTML comments, and any other place where the origin URL appears.
    output = this._rewriteRemainingOriginUrls(output, baseUrl, pageFilePath);

    return output;
  }

  /**
   * Rewrite all url() references in a CSS file on disk.
   * @param {string} cssFilePath - Absolute path to the CSS file
   * @param {string} cssUrl - Original absolute URL of the CSS file
   */
  async rewriteCssFile(cssFilePath, cssUrl) {
    try {
      const css = await readFile(cssFilePath, 'utf-8');
      const { filePath: cssLocalPath } = urlToFilePath(cssUrl, this.outputDir);
      const rewritten = this._rewriteCssUrls(css, cssUrl, cssLocalPath);
      if (rewritten !== css) {
        await writeFile(cssFilePath, rewritten);
      }
    } catch {
      // Could not process CSS file
    }
  }

  /**
   * Rewrite asset URL strings in a JS file on disk.
   * @param {string} jsFilePath - Absolute path to the JS file
   * @param {string} jsUrl - Original absolute URL of the JS file
   */
  async rewriteJsFile(jsFilePath, jsUrl) {
    try {
      const js = await readFile(jsFilePath, 'utf-8');
      const { filePath: jsLocalPath } = urlToFilePath(jsUrl, this.outputDir);
      
      const stringPattern = /(['"`])((?:https?:\/\/[^'"`]+?|\/[^'"`]+?|[a-zA-Z0-9_\-]+\/[^'"`]+?)\.(?:png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|eot|css|js))\1/gi;
      
      const rewritten = js.replace(stringPattern, (match, quote, ref) => {
        if (ref.startsWith('data:') || ref.startsWith('#')) return match;
        
        const newUrl = this._resolveAndRewrite(ref, jsUrl, jsLocalPath);
        if (newUrl !== null) {
          return `${quote}${newUrl}${quote}`;
        }
        return match;
      });

      if (rewritten !== js) {
        await writeFile(jsFilePath, rewritten);
      }
    } catch {
      // Could not process JS file
    }
  }

  /**
   * Resolve a URL and rewrite it to a relative path.
   * @returns {string|null} The relative path, or null if not rewritable
   */
  _resolveAndRewrite(urlStr, contextUrl, contextFilePath) {
    try {
      const absolute = new URL(urlStr, contextUrl).href;

      if (!isInternalUrl(absolute, this.origin)) {
        return null; // External URL — leave as-is
      }

      // Check if it's a known page
      const normalized = normalizeUrl(absolute, this.origin);
      let targetFilePath = this.pageMap.get(normalized);

      if (!targetFilePath) {
        // Check asset map
        targetFilePath = this.assetMap.get(normalized);
      }

      if (!targetFilePath) {
        // Not a downloaded resource — compute what the path *would* be
        const { filePath } = urlToFilePath(absolute, this.outputDir);
        targetFilePath = filePath;
      }

      // Compute relative path
      return this._computeRelative(contextFilePath, targetFilePath);
    } catch {
      return null;
    }
  }

  /**
   * Rewrite url() and @import references in CSS text.
   */
  _rewriteCssUrls(css, contextUrl, contextFilePath) {
    // Rewrite url()
    css = css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, ref) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return match;

      const rewritten = this._resolveAndRewrite(ref, contextUrl, contextFilePath);
      if (rewritten !== null) {
        return `url('${rewritten}')`;
      }
      return match;
    });

    // Rewrite @import
    css = css.replace(/@import\s+['"]([^'"]+)['"]/g, (match, ref) => {
      const rewritten = this._resolveAndRewrite(ref, contextUrl, contextFilePath);
      if (rewritten !== null) {
        return `@import '${rewritten}'`;
      }
      return match;
    });

    return css;
  }

  /**
   * Ensure a URL ends with '/' if its path looks like a directory (no file extension).
   * This is critical for correct relative URL resolution.
   */
  _ensureTrailingSlash(urlStr) {
    try {
      const parsed = new URL(urlStr);
      const lastSegment = parsed.pathname.split('/').pop() || '';
      const hasExtension = lastSegment.includes('.') && !lastSegment.startsWith('.');
      if (!hasExtension && !parsed.pathname.endsWith('/')) {
        parsed.pathname += '/';
      }
      return parsed.href;
    } catch {
      return urlStr;
    }
  }

  /**
   * Rewrite any remaining absolute URLs pointing to this.origin in raw HTML text.
   * This is a catch-all that runs on the serialized HTML string after Cheerio processing,
   * ensuring URLs in any context (attribute values, inline scripts, JSON-LD, comments, etc.)
   * are rewritten to relative paths.
   * @param {string} html - Serialized HTML string
   * @param {string} baseUrl - Base URL for resolving relative refs
   * @param {string} pageFilePath - Local file path of the current page
   * @returns {string} HTML with remaining origin URLs rewritten
   */
  _rewriteRemainingOriginUrls(html, baseUrl, pageFilePath) {
    // Escape origin for use in regex (handles dots, colons, slashes)
    const escapedOrigin = this.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match the origin followed by an optional path+query+fragment, stopping at whitespace,
    // quotes, angle brackets, or other URL-terminating characters.
    // This intentionally matches both http and https variants if the origin uses either.
    const pattern = new RegExp(escapedOrigin + '(\\/[^\\s"\'<>\\]\\)]*)?', 'g');

    return html.replace(pattern, (match) => {
      // Skip data: URIs and fragments that somehow matched
      if (match.startsWith('data:') || match === '#') return match;

      const rewritten = this._resolveAndRewrite(match, baseUrl, pageFilePath);
      return rewritten !== null ? rewritten : match;
    });
  }

  /**
   * Compute relative path from one file to another (both relative to outputDir).
   */
  _computeRelative(fromFilePath, toFilePath) {
    const fromDir = posix.dirname(fromFilePath.replace(/\\/g, '/'));
    const toNorm = toFilePath.replace(/\\/g, '/');
    let rel = posix.relative(fromDir, toNorm);
    if (!rel.startsWith('.')) {
      rel = './' + rel;
    }
    return rel;
  }

  /**
   * Record a redirect mapping (for .htaccess generation).
   */
  addRedirect(from, to) {
    this.redirects.push({ from, to });
  }

  /**
   * Get all recorded redirects.
   */
  getRedirects() {
    return this.redirects;
  }
}
