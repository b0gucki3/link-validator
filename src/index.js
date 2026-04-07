#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';

const DEFAULT_CONCURRENCY = 1;
const USER_AGENT = 'link-validator/1.0 (+https://piquant.ie)';
const SOFT_404_PATTERNS = [
  /\b404\b/i,
  /page not found/i,
  /not found/i,
  /does(?: not|n't) exist/i,
  /no longer available/i,
  /has been removed/i,
  /content unavailable/i,
  /listing (?:is )?unavailable/i,
  /product unavailable/i,
  /sorry[, ]+we can(?:not|'t) find/i,
];

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.sitemap) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const concurrency = Number.isFinite(args.concurrency) ? Math.max(1, args.concurrency) : DEFAULT_CONCURRENCY;
  const outDir = resolve(process.cwd(), args.outDir || '.');

  await mkdir(outDir, { recursive: true });

  const sitemapUrl = args.sitemap;
  const domain = getDomainFromUrl(sitemapUrl);
  const outputFile = resolve(outDir, `${domain}-data.md`);

  console.log(`Collecting URLs from sitemap: ${sitemapUrl}`);
  const collectedPageUrls = await collectUrlsFromSitemap(sitemapUrl);

  if (!collectedPageUrls.length) {
    throw new Error('No page URLs were found in the sitemap.');
  }

  const pageUrls = args.debug ? collectedPageUrls.slice(0, 30) : collectedPageUrls;

  if (args.debug) {
    console.log(`Debug mode enabled. Limiting sitemap page processing to the first ${pageUrls.length} URL(s).`);
  }

  console.log(`Found ${collectedPageUrls.length} page URL(s). Processing ${pageUrls.length} with concurrency ${concurrency}...`);

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

  console.log(`Validating ${records.length} extracted link record(s)...`);
  await validateRecords(records, sitemapUrl, concurrency);

  const markdown = buildMarkdownReport({
    generatedAt: new Date().toISOString(),
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
    debug: false,
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

    if (arg === '--debug') {
      const value = (argv[i + 1] || '').toLowerCase();
      if (value === 'true' || value === 'false') {
        args.debug = value === 'true';
        i += 1;
      } else {
        args.debug = true;
      }
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:\n  node src/index.js --sitemap <url> [--out <dir>] [--concurrency <n>] [--debug [true|false]]\n\nExamples:\n  node src/index.js --sitemap https://piquant.ie/sitemap.xml --out ./reports\n  node src/index.js --sitemap https://piquant.ie/sitemap.xml --out ./reports --debug true`);
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

async function fetchValidationDetails(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    },
    redirect: 'follow',
  });

  const contentType = response.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
  const body = isHtml ? await response.text() : '';

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    finalUrl: response.url,
    contentType,
    body,
  };
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
      resolvedUrl: '',
      urlValidationStatus: '',
      finalUrl: '',
      httpStatus: '',
      validationNotes: '',
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

async function validateRecords(records, sitemapUrl, concurrency) {
  const prepared = records.map((record, index) => ({
    record,
    index,
    normalizedInputUrl: String(record.url ?? '').trim(),
    resolvedUrl: '',
    preValidationResult: null,
  }));

  const cache = new Map();
  const uniqueResolvedUrlsToValidate = [];

  for (const item of prepared) {
    const preflight = prepareValidationTarget(item.normalizedInputUrl, sitemapUrl);

    if (preflight.immediateResult) {
      item.preValidationResult = preflight.immediateResult;
      continue;
    }

    item.resolvedUrl = preflight.resolvedUrl;

    if (!cache.has(preflight.resolvedUrl)) {
      cache.set(preflight.resolvedUrl, null);
      uniqueResolvedUrlsToValidate.push(preflight.resolvedUrl);
    }
  }

  console.log(`Prepared ${records.length} record(s) for validation; ${uniqueResolvedUrlsToValidate.length} unique URL(s) require network checks.`);

  await runWithConcurrency(uniqueResolvedUrlsToValidate, concurrency, async (resolvedUrl, index) => {
    console.log(`[validate ${index + 1}/${uniqueResolvedUrlsToValidate.length}] ${resolvedUrl}`);
    const result = await validateResolvedUrl(resolvedUrl);
    cache.set(resolvedUrl, result);
  });

  for (const item of prepared) {
    const result = item.preValidationResult || cache.get(item.resolvedUrl) || {
      resolvedUrl: item.resolvedUrl,
      urlValidationStatus: 'connection_error',
      finalUrl: '',
      httpStatus: '',
      validationNotes: 'Validation result missing from cache',
    };

    item.record.resolvedUrl = result.resolvedUrl;
    item.record.urlValidationStatus = result.urlValidationStatus;
    item.record.finalUrl = result.finalUrl;
    item.record.httpStatus = result.httpStatus;
    item.record.validationNotes = result.validationNotes;
  }
}

function prepareValidationTarget(rawUrl, sitemapUrl) {
  const trimmedUrl = String(rawUrl ?? '').trim();

  if (!trimmedUrl) {
    return {
      resolvedUrl: '',
      immediateResult: {
        resolvedUrl: '',
        urlValidationStatus: 'not_applicable',
        finalUrl: '',
        httpStatus: '',
        validationNotes: 'Empty URL value',
      },
    };
  }

  if (trimmedUrl.startsWith('#')) {
    return {
      resolvedUrl: '',
      immediateResult: {
        resolvedUrl: '',
        urlValidationStatus: 'not_applicable',
        finalUrl: '',
        httpStatus: '',
        validationNotes: 'Fragment-only URL',
      },
    };
  }

  if (isNonWebScheme(trimmedUrl)) {
    return {
      resolvedUrl: '',
      immediateResult: {
        resolvedUrl: '',
        urlValidationStatus: 'not_applicable',
        finalUrl: '',
        httpStatus: '',
        validationNotes: `Non-web scheme: ${trimmedUrl.split(':', 1)[0]}`,
      },
    };
  }

  try {
    return {
      resolvedUrl: resolveCandidateUrl(trimmedUrl, sitemapUrl),
      immediateResult: null,
    };
  } catch (error) {
    return {
      resolvedUrl: '',
      immediateResult: {
        resolvedUrl: '',
        urlValidationStatus: 'invalid_url',
        finalUrl: '',
        httpStatus: '',
        validationNotes: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function validateResolvedUrl(resolvedUrl) {
  try {
    const response = await fetchValidationDetails(resolvedUrl);
    const classification = classifyValidationResult(response, resolvedUrl);

    return {
      resolvedUrl,
      urlValidationStatus: classification.urlValidationStatus,
      finalUrl: response.finalUrl,
      httpStatus: String(response.status),
      validationNotes: classification.validationNotes,
    };
  } catch (error) {
    return {
      resolvedUrl,
      urlValidationStatus: classifyNetworkError(error),
      finalUrl: '',
      httpStatus: '',
      validationNotes: error instanceof Error ? error.message : String(error),
    };
  }
}

function classifyValidationResult(response, requestedUrl) {
  const notes = [];
  const finalUrl = response.finalUrl || '';
  const redirected = finalUrl && finalUrl !== requestedUrl;
  const soft404 = isSoft404(response.body, finalUrl || requestedUrl);
  const externalTarget = isThirdPartyTarget(requestedUrl, finalUrl || requestedUrl);

  if (redirected) {
    notes.push(`Redirected to ${finalUrl}`);
  }

  if (response.status === 404 || response.status === 410) {
    return {
      urlValidationStatus: externalTarget ? 'third_party_404' : 'not_found',
      validationNotes: notes.join('; '),
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      urlValidationStatus: 'blocked',
      validationNotes: notes.join('; '),
    };
  }

  if (response.status >= 500) {
    return {
      urlValidationStatus: 'server_error',
      validationNotes: notes.join('; '),
    };
  }

  if (soft404) {
    notes.push('Soft-404 pattern detected in response body');
    return {
      urlValidationStatus: externalTarget ? 'third_party_404' : 'soft_404',
      validationNotes: notes.join('; '),
    };
  }

  if (response.ok && redirected) {
    return {
      urlValidationStatus: 'redirected_valid',
      validationNotes: notes.join('; '),
    };
  }

  if (response.ok) {
    return {
      urlValidationStatus: 'valid',
      validationNotes: notes.join('; '),
    };
  }

  return {
    urlValidationStatus: 'connection_error',
    validationNotes: notes.join('; ') || `Unexpected HTTP status ${response.status}`,
  };
}

function isSoft404(body, url) {
  if (!body) {
    return false;
  }

  const sample = body.slice(0, 20000);
  return SOFT_404_PATTERNS.some((pattern) => pattern.test(sample)) || /\/404(?:\/|$)/i.test(url);
}

function isThirdPartyTarget(requestedUrl, finalUrl) {
  try {
    const requestedHost = new URL(requestedUrl).hostname.replace(/^www\./, '');
    const finalHost = new URL(finalUrl).hostname.replace(/^www\./, '');
    return requestedHost !== finalHost;
  } catch {
    return false;
  }
}

function isNonWebScheme(value) {
  return /^(mailto|tel|javascript|sms|data):/i.test(value);
}

function resolveCandidateUrl(value, sitemapUrl) {
  if (value === '/' || value.startsWith('/')) {
    return new URL(value, sitemapUrl).toString();
  }

  const parsed = new URL(value, sitemapUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  return parsed.toString();
}

function classifyNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (/timed? out/i.test(message)) {
    return 'timeout';
  }

  if (/ENOTFOUND|DNS|domain name/i.test(message)) {
    return 'dns_error';
  }

  return 'connection_error';
}

function buildMarkdownReport({ generatedAt, sitemapUrl, pageCount, uniqueLinkCount, records, faultyTags, fetchErrors }) {
  const lines = [];
  const validationSummary = summarizeValidation(records);

  lines.push(`# Link Extraction Report`);
  lines.push('');
  lines.push(`- Report generated at: ${generatedAt || new Date().toISOString()}`);
  lines.push(`- Sitemap: ${sitemapUrl}`);
  lines.push(`- Pages processed: ${pageCount}`);
  lines.push(`- Unique links: ${uniqueLinkCount}`);
  lines.push(`- Unique resolved URLs validated: ${validationSummary.uniqueResolvedUrlCount}`);
  lines.push(`- Validation-ready records: ${validationSummary.validationReadyRecordCount}`);
  lines.push(`- Not applicable records: ${validationSummary.notApplicableRecordCount}`);
  lines.push(`- Faulty tag candidates: ${faultyTags.length}`);
  lines.push(`- Fetch errors: ${fetchErrors.length}`);
  lines.push('');
  lines.push('## Validation Summary');
  lines.push('');

  if (!validationSummary.totalRecords) {
    lines.push('_No link records found._');
  } else {
    lines.push(`- Total records: ${validationSummary.totalRecords}`);
    for (const [status, count] of Object.entries(validationSummary.statusCounts)) {
      lines.push(`- ${status}: ${count}`);
    }
  }

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
      lines.push(`- Resolved URL: ${formatValue(record.resolvedUrl)}`);
      lines.push(`- URL Validation Status: ${formatValue(record.urlValidationStatus)}`);
      lines.push(`- Final URL: ${formatValue(record.finalUrl)}`);
      lines.push(`- HTTP Status: ${formatValue(record.httpStatus)}`);
      lines.push(`- Validation Notes: ${formatValue(record.validationNotes)}`);
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

function summarizeValidation(records) {
  const statusCounts = {};
  const uniqueResolvedUrls = new Set();
  let validationReadyRecordCount = 0;
  let notApplicableRecordCount = 0;

  for (const record of records) {
    const status = record.urlValidationStatus || 'unvalidated';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (status === 'not_applicable') {
      notApplicableRecordCount += 1;
    } else {
      validationReadyRecordCount += 1;
    }

    if (record.resolvedUrl) {
      uniqueResolvedUrls.add(record.resolvedUrl);
    }
  }

  return {
    totalRecords: records.length,
    uniqueResolvedUrlCount: uniqueResolvedUrls.size,
    validationReadyRecordCount,
    notApplicableRecordCount,
    statusCounts: Object.fromEntries(Object.entries(statusCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
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
