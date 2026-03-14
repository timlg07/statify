# Statify

Statify is a Node.js CLI tool that uses Puppeteer to scrape CMS-based websites (like WordPress, e107, Contao, etc.) and generate a fully self-contained, deployable static copy.

## Features

- **Full DOM Capture**: Renders JavaScript before capturing the page to support dynamic content, comments, and pagination.
- **Asset Downloading**: Automatically downloads CSS, JS, images, fonts, favicons, open-graph images, and parses CSS `url()` references.
- **URL Rewriting**: Rewrites all internal links and asset references to relative paths (`../style.css`), allowing the site to work offline or in any subfolder.
- **Smart Redirect Handling**: Detects server-side redirects (e.g., `/` to `/home/`) and generates lightweight fallback redirects (`.htaccess`, `index.php`, `<meta>` refresh) instead of duplicating HTML.
- **Query Param Conversion**: Safely converts URLs with query parameters into flat files (e.g., `?page=2` -> `_page_2.html`). Provides 301 redirects for the original URLs via `.htaccess`.

## Installation

Ensure you have [Node.js](https://nodejs.org/) installed (v18+ recommended).

Clone the repository and install dependencies:

```bash
git clone https://github.com/timlg07/statify
cd statify
npm install
```

## Usage

Run the CLI tool using `node bin/statify.js`:

```bash
node bin/statify.js https://example.com
```

### Options

```text
Usage: statify [options] <url>

Scrape a CMS-based website and generate a deployable static copy

Arguments:
  url                    URL of the website to scrape (e.g. https://example.com)

Options:
  -V, --version          output the version number
  -o, --output <dir>     Output directory (default: domain name)
  -c, --concurrency <n>  Number of pages to crawl in parallel (default: 1)
  -t, --timeout <ms>     Navigation timeout per page in milliseconds (default: 30000)
  --user-agent <string>  Custom User-Agent string
  --no-js                Disable JavaScript rendering capture
  --max-depth <n>        Maximum crawl depth from homepage (default: unlimited)
  -s, --show             Show browser window (non-headless mode)
  -v, --verbose          Enable verbose logging
  -h, --help             display help for command
```

### Examples

**Basic crawl (saves to `./example.com`):**
```bash
node bin/statify.js https://example.com
```

**Crawl with a max depth of 3 and verbose logging:**
```bash
node bin/statify.js https://example.com --max-depth 3 -v
```

**Crawl rapidly (parallel pages) and watch the browser (headed mode):**
```bash
node bin/statify.js https://example.com -c 4 --show
```

## Deployment

Once Statify finishes, the output directory contains a pure static site. You can deploy it directly to GitHub Pages, Netlify, Vercel, or any standard Apache/Nginx web server. The tool automatically generates an `.htaccess` file for handling server-side redirects.
