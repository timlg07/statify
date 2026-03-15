import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, posix } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import http from 'node:http';

/**
 * Normalize a URL for deduplication:
 * - Resolve against base
 * - Strip fragment
 * - Strip trailing slash (except for root "/")
 */
export function normalizeUrl(url, base) {
  try {
    const resolved = new URL(url, base);
    
    if (base) {
      try {
        const baseParsed = new URL(base);
        if (resolved.host === baseParsed.host) {
          resolved.protocol = baseParsed.protocol;
        }
      } catch {}
    }

    resolved.hash = '';
    let pathname = resolved.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    resolved.pathname = pathname;
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is internal (same origin).
 */
export function isInternalUrl(url, origin) {
  try {
    const parsed = new URL(url);
    const originParsed = new URL(origin);
    return parsed.host === originParsed.host;
  } catch {
    return false;
  }
}

/**
 * Sanitize a query string by replacing special characters with underscores.
 * Used so that URLs with query params become valid filenames.
 * e.g. "?page=2&sort=date" → "_page_2_sort_date"
 */
export function sanitizeQueryString(search) {
  if (!search) return '';
  // Remove leading '?', then replace &, =, and other special chars with _
  return '_' + search
    .slice(1)
    .replace(/[?&=%#+]/g, '_')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
}

/**
 * Determine if a URL points to a static asset (image, video, document) based on its file extension.
 * Helps prevent the crawler from trying to navigate to non-HTML pages.
 * @param {string} urlStr 
 * @returns {boolean}
 */
export function isAssetUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const pathname = parsed.pathname.toLowerCase();
    const assetExtensions = [
      '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff',
      '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.flac', '.aac', '.m4a',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz',
      '.woff', '.woff2', '.ttf', '.eot', '.otf',
      '.css', '.js', '.json', '.xml', '.csv', '.txt'
    ];
    return assetExtensions.some(ext => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * Convert a URL into a filesystem path within the output directory.
 *
 * - "/blog/page-2/" → "blog/page-2/index.html"
 * - "/blog/page-2"  → "blog/page-2/index.html" (if no extension)
 * - "/style.css"    → "style.css"
 * - "/?page=2"      → "index_page_2.html"
 * - "/blog/?page=3" → "blog/index_page_3.html"
 *
 * Returns { filePath, redirectFrom } where redirectFrom is set if query params were sanitized.
 */
export function urlToFilePath(urlStr, outputDir) {
  try {
    const parsed = new URL(urlStr);
    let pathname = decodeURIComponent(parsed.pathname);

    // Remove leading slash
    if (pathname.startsWith('/')) {
      pathname = pathname.slice(1);
    }

    const querySuffix = sanitizeQueryString(parsed.search);
    let redirectFrom = null;

    if (querySuffix) {
      // Store original path+query for .htaccess redirect
      redirectFrom = parsed.pathname + parsed.search;
    }

    // Determine if path looks like it ends with a file extension
    const lastSegment = pathname.split('/').pop() || '';
    const hasExtension = lastSegment.includes('.') && !lastSegment.startsWith('.');

    let filePath;
    if (!pathname || pathname.endsWith('/')) {
      // Directory-style URL → index.html
      filePath = pathname + 'index' + querySuffix + '.html';
    } else if (!hasExtension) {
      // No extension — treat as directory
      filePath = pathname + '/index' + querySuffix + '.html';
    } else if (querySuffix) {
      // Has extension AND query params — embed query in filename
      const dotIdx = lastSegment.lastIndexOf('.');
      const dir = pathname.substring(0, pathname.length - lastSegment.length);
      const name = lastSegment.substring(0, dotIdx);
      const ext = lastSegment.substring(dotIdx);
      filePath = dir + name + querySuffix + ext;
    } else {
      filePath = pathname;
    }

    // Normalize to forward slashes
    filePath = filePath.replace(/\\/g, '/');

    const fullPath = outputDir.replace(/\\/g, '/') + '/' + filePath;
    return { filePath, fullPath, redirectFrom };
  } catch {
    return { filePath: 'index.html', fullPath: outputDir + '/index.html', redirectFrom: null };
  }
}

/**
 * Compute the relative path from one file to another within the output directory.
 * Both paths should be relative to the output directory root.
 */
export function computeRelativePath(fromFilePath, toFilePath) {
  const fromDir = posix.dirname(fromFilePath);
  let rel = posix.relative(fromDir, toFilePath);
  if (!rel.startsWith('.')) {
    rel = './' + rel;
  }
  return rel;
}

/**
 * Ensure a directory exists (recursive mkdir).
 */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

/**
 * Save content to a file, creating parent directories as needed.
 */
export async function saveFile(filePath, content) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, content);
}

/**
 * Download a file from a URL to a destination path.
 * Returns true on success, false on failure.
 */
export function downloadFile(url, dest, retries = 2) {
  return new Promise(async (resolve) => {
    await ensureDir(dirname(dest));

    const attempt = (remaining) => {
      const client = url.startsWith('https') ? https : http;
      const request = client.get(url, { timeout: 30000 }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          res.resume(); // consume the response
          if (remaining > 0) {
            const redirectClient = redirectUrl.startsWith('https') ? https : http;
            redirectClient.get(redirectUrl, { timeout: 30000 }, (redirectRes) => {
              handleResponse(redirectRes, remaining);
            }).on('error', () => resolve(false));
          } else {
            resolve(false);
          }
          return;
        }

        handleResponse(res, remaining);
      });

      request.on('error', () => {
        if (remaining > 0) attempt(remaining - 1);
        else resolve(false);
      });

      request.on('timeout', () => {
        request.destroy();
        if (remaining > 0) attempt(remaining - 1);
        else resolve(false);
      });
    };

    const handleResponse = async (res, remaining) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (remaining > 0) attempt(remaining - 1);
        else resolve(false);
        return;
      }

      try {
        const chunks = [];
        const writable = new Writable({
          write(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
          }
        });

        await pipeline(res, writable);
        const buffer = Buffer.concat(chunks);
        await saveFile(dest, buffer);
        resolve(true);
      } catch {
        if (remaining > 0) attempt(remaining - 1);
        else resolve(false);
      }
    };

    attempt(retries);
  });
}

/**
 * Simple logger with verbosity.
 */
export class Logger {
  constructor(verbose = false) {
    this.verbose = verbose;
  }

  info(msg) {
    console.log(`[statify] ${msg}`);
  }

  debug(msg) {
    if (this.verbose) {
      console.log(`[statify:debug] ${msg}`);
    }
  }

  warn(msg) {
    console.warn(`[statify:warn] ${msg}`);
  }

  error(msg) {
    console.error(`[statify:error] ${msg}`);
  }

  success(msg) {
    console.log(`[statify] ✓ ${msg}`);
  }
}
