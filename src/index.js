#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

const DEFAULT_CONCURRENCY = 4;
const USER_AGENT = 'link-validator/1.0 (+https://piquant.ie)';

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.sitemap) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const sitemapUrl = args.sitemap;
  const concurrency = Number.isFinite(args.concurrency) ? Math.max(1, args.concurrency) : DEFAULT_CONCURRENCY;
  const outDir = resolve(process.cwd(), args.outDir || '.');

  await mkdir(outDir, { recursive: true });

  const domain = getDomainFromUrl(sitemapUrl);
  const outputFile = resolve(outDir, `${domain}-data.md`);

  console.log(`Collecting URLs from sitemap: ${sitemapUrl}`);
  const pageUrls = await collectUrlsFromSitemap(sitemapUrl);

  if (!pageUrls.length) {
    throw new Error('No page URLs were found in the sitemap.');
  }

  console.log(`Found ${pageUrls.length} page URL(s). Processing with concurrency ${concurrency}...`);

  const records = [];
  const faultyTags = [];
  const fetchErrors = [];
  const seen = new Set();

  await runWithConcurrency(pageUrls, concurrency, async (pageUrl, index) => {
    try {
      console.log(`[${index + 1}/${pageUrls.length}] ${pageUrl}`);
      const html = await fetchText(pageUrl);
      const result = extractLinksFromHtml(html, pageUrl);

      for (const record of result.records) {
        const key = JSON.stringify(record);
        if (!seen.has(key)) {
          seen.add(key);
          records.push(record);
        }
      }

      for (const faulty of result.faultyTags) {
        faultyTags.push(faulty);
      }
    } catch (error) {
      fetchErrors.push({
        pageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const markdown = buildMarkdownReport({
    sitemapUrl,
    pageCount: pageUrls.length,
    uniqueLinkCount: records.length,
    records,
    faultyTags,
    fetchErrors,
  });

  await writeFile(outputFile, markdown, 'utf8');

  console.log(`Done. Wrote ${records.length} unique link record(s) to ${outputFile}`);
  if (faultyTags.length) {
    console.log(`Logged ${faultyTags.length} faulty tag candidate(s).`);
  }
  if (fetchErrors.length) {
    console.log(`Logged ${fetchErrors.length} fetch error(s).`);
  }
}

function parseArgs(argv) {
  const args = {
    sitemap: '',
    outDir: '.',
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg === '--sitemap') {
      args.sitemap = argv[i + 1] || '';
      i += 1;
      continue;
    }

    if (arg === '--out') {
      args.outDir = argv[i + 1] || '.';
      i += 1;
      continue;
    }

    if (arg === '--concurrency') {
      args.concurrency = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:\n  node src/index.js --sitemap <url> [--out <dir>] [--concurrency <n>]\n\nExample:\n  node src/index.js --sitemap https://piquant.ie/sitemap.xml --out ./reports`);
}

async function collectUrlsFromSitemap(sitemapUrl, visited = new Set()) {
  if (visited.has(sitemapUrl)) {
    return [];
  }

  visited.add(sitemapUrl);

  const xml = await fetchText(sitemapUrl);
  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);

  if (parsed.urlset?.url) {
    const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    return urls
      .map((entry) => entry.loc)
      .filter(Boolean);
  }

  if (parsed.sitemapindex?.sitemap) {
    const sitemapEntries = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    const nested = await Promise.all(
      sitemapEntries
        .map((entry) => entry.loc)
        .filter(Boolean)
        .map((nestedUrl) => collectUrlsFromSitemap(nestedUrl, visited)),
    );

    return [...new Set(nested.flat())];
  }

  throw new Error(`Unsupported sitemap format at ${sitemapUrl}`);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function extractLinksFromHtml(html, pageUrl) {
  const $ = cheerio.load(html, {
    decodeEntities: false,
    xmlMode: false,
  });

  const records = [];
  const faultyTags = detectFaultyAnchorTags(html, pageUrl);

  $('a').each((_, element) => {
    const text = $(element).text();
    const href = $(element).attr('href') ?? '';
    const target = $(element).attr('target') ?? '';
    const rawTag = $.html(element);

    records.push({
      nameText: text,
      url: href,
      target,
      parentUrl: pageUrl,
      fullRawTag: rawTag,
    });
  });

  return { records, faultyTags };
}

function detectFaultyAnchorTags(html, pageUrl) {
  const faulty = [];
  const anchorCandidates = html.match(/<a\b[^>]*>/gi) || [];

  for (const tag of anchorCandidates) {
    const issues = [];

    if (/\bhref\s*=\s*[^"'\s>][^\s>]*/i.test(tag)) {
      issues.push('href appears to be unquoted');
    }

    if (/\btarget\s*=\s*[^"'\s>][^\s>]*/i.test(tag)) {
      issues.push('target appears to be unquoted');
    }

    const doubleQuotes = (tag.match(/"/g) || []).length;
    const singleQuotes = (tag.match(/'/g) || []).length;
    if (doubleQuotes % 2 !== 0 || singleQuotes % 2 !== 0) {
      issues.push('quote count appears unbalanced');
    }

    if (!tag.endsWith('>')) {
      issues.push('tag appears truncated');
    }

    if (issues.length) {
      faulty.push({
        parentUrl: pageUrl,
        rawTag: tag,
        issues: issues.join('; '),
      });
    }
  }

  return faulty;
}

function buildMarkdownReport({ sitemapUrl, pageCount, uniqueLinkCount, records, faultyTags, fetchErrors }) {
  const lines = [];

  lines.push(`# Link Extraction Report`);
  lines.push('');
  lines.push(`- Sitemap: ${sitemapUrl}`);
  lines.push(`- Pages processed: ${pageCount}`);
  lines.push(`- Unique links: ${uniqueLinkCount}`);
  lines.push(`- Faulty tag candidates: ${faultyTags.length}`);
  lines.push(`- Fetch errors: ${fetchErrors.length}`);
  lines.push('');
  lines.push('## Link Data');
  lines.push('');

  if (!records.length) {
    lines.push('_No link records found._');
  } else {
    for (const [index, record] of records.entries()) {
      lines.push(`### Link ${index + 1}`);
      lines.push('');
      lines.push(`- Name/Text: ${formatValue(record.nameText)}`);
      lines.push(`- URL: ${formatValue(record.url)}`);
      lines.push(`- Target: ${formatValue(record.target)}`);
      lines.push(`- Parent URL: ${formatValue(record.parentUrl)}`);
      lines.push(`- Full Raw Tag:`);
      lines.push('');
      lines.push('```html');
      lines.push(String(record.fullRawTag ?? ''));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Faulty Tags');
  lines.push('');

  if (!faultyTags.length) {
    lines.push('_No faulty tag candidates detected._');
  } else {
    for (const [index, faulty] of faultyTags.entries()) {
      lines.push(`### Faulty Tag ${index + 1}`);
      lines.push('');
      lines.push(`- Parent URL: ${formatValue(faulty.parentUrl)}`);
      lines.push(`- Issues: ${formatValue(faulty.issues)}`);
      lines.push(`- Full Raw Tag:`);
      lines.push('');
      lines.push('```html');
      lines.push(String(faulty.rawTag ?? ''));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## Fetch Errors');
  lines.push('');

  if (!fetchErrors.length) {
    lines.push('_No fetch errors._');
  } else {
    for (const [index, error] of fetchErrors.entries()) {
      lines.push(`### Fetch Error ${index + 1}`);
      lines.push('');
      lines.push(`- Parent URL: ${formatValue(error.pageUrl)}`);
      lines.push(`- Error: ${formatValue(error.error)}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatValue(value) {
  const stringValue = String(value ?? '');
  return stringValue.length ? stringValue.replace(/\r?\n/g, '<br>') : '_empty_';
}

function getDomainFromUrl(url) {
  const { hostname } = new URL(url);
  return hostname.replace(/^www\./, '');
}

async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;

  async function next() {
    const currentIndex = index;
    index += 1;

    if (currentIndex >= items.length) {
      return;
    }

    await worker(items[currentIndex], currentIndex);
    await next();
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(runners);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
