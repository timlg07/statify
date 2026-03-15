import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { downloadFile, urlToFilePath, normalizeUrl, isInternalUrl, saveFile, Logger } from './utils.js';

/**
 * Downloads and tracks all static assets (CSS, JS, images, fonts, etc.)
 * for a scraped site. Also parses CSS files for nested url() references.
 */
export class AssetDownloader {
  /**
   * @param {string} origin - The origin of the site being scraped (e.g. "https://example.com")
   * @param {string} outputDir - Absolute path to the output directory
   * @param {Logger} logger
   */
  constructor(origin, outputDir, logger) {
    this.origin = origin;
    this.outputDir = outputDir;
    this.logger = logger;

    /** @type {Map<string, string>} Maps original absolute URL → local file path (relative to outputDir) */
    this.downloadedAssets = new Map();

    /** @type {Set<string>} URLs currently being downloaded or already processed */
    this.processing = new Set();
  }

  /**
   * Download an asset if it hasn't been downloaded yet.
   * Returns the local file path relative to the output directory.
   * @param {string} assetUrl - Absolute URL of the asset
   * @returns {Promise<string|null>} Relative file path within output dir, or null on failure
   */
  async download(assetUrl) {
    if (assetUrl.startsWith('data:') || assetUrl.startsWith('blob:')) {
      return null;
    }

    // Normalize
    const normalized = normalizeUrl(assetUrl, this.origin);
    if (!normalized) return null;

    // Already downloaded?
    if (this.downloadedAssets.has(normalized)) {
      return this.downloadedAssets.get(normalized);
    }

    // Already processing (prevents infinite loops in CSS references)?
    if (this.processing.has(normalized)) {
      return null;
    }

    this.processing.add(normalized);

    const { filePath, fullPath } = urlToFilePath(normalized, this.outputDir);

    // Skip if already on disk (from a previous run perhaps)
    if (existsSync(fullPath)) {
      this.downloadedAssets.set(normalized, filePath);
      return filePath;
    }

    this.logger.debug(`Downloading asset: ${normalized}`);
    const success = await downloadFile(normalized, fullPath);

    if (success) {
      this.downloadedAssets.set(normalized, filePath);

      // If it's a CSS file, parse it for additional asset references
      if (filePath.endsWith('.css')) {
        await this.processCssFile(fullPath, normalized);
      }

      return filePath;
    } else {
      this.logger.warn(`Failed to download: ${normalized}`);
      return null;
    }
  }

  /**
   * Download multiple assets in parallel (with a simple limit).
   * @param {string[]} urls - Array of absolute asset URLs
   * @returns {Promise<Map<string, string>>} Map of originalUrl → localFilePath
   */
  async downloadMany(urls) {
    const results = new Map();
    const batchSize = 5;

    for (let i = 0; i < urls.length; i += batchSize) {
      const batch = urls.slice(i, i + batchSize);
      const promises = batch.map(async (url) => {
        const localPath = await this.download(url);
        if (localPath) {
          results.set(url, localPath);
        }
      });
      await Promise.all(promises);
    }

    return results;
  }

  /**
   * Parse a downloaded CSS file for url() and @import references,
   * and download those assets too.
   */
  async processCssFile(cssFilePath, cssUrl) {
    try {
      const css = await readFile(cssFilePath, 'utf-8');
      const urlPattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
      const importPattern = /@import\s+['"]([^'"]+)['"]/g;

      const refs = new Set();

      let match;
      while ((match = urlPattern.exec(css)) !== null) {
        const ref = match[1].trim();
        if (!ref.startsWith('data:') && !ref.startsWith('#')) {
          refs.add(ref);
        }
      }
      while ((match = importPattern.exec(css)) !== null) {
        refs.add(match[1].trim());
      }

      for (const ref of refs) {
        try {
          const absoluteUrl = new URL(ref, cssUrl).href;
          if (isInternalUrl(absoluteUrl, this.origin)) {
            await this.download(absoluteUrl);
          }
        } catch {
          // Invalid URL, skip
        }
      }
    } catch {
      // Could not read/parse CSS, skip
    }
  }

  /**
   * Get the map of all downloaded assets.
   * @returns {Map<string, string>}
   */
  getAssetMap() {
    return this.downloadedAssets;
  }

  /**
   * Restore the downloaded asset map from a saved state.
   * @param {Map<string, string>} map 
   */
  setAssetMap(map) {
    this.downloadedAssets = map;
  }
}
