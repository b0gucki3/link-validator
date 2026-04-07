# Link Validator

Sitemap-driven link extraction and validation utility.

## What it does

- Accepts a sitemap URL
- Expands sitemap indexes recursively
- Fetches each page listed in the sitemap
- Extracts every `<a>` tag found on each page
- Produces a markdown report named after the domain, for example `piquant.ie-data.md`
- Uses a record-by-record markdown list format for better readability
- Deduplicates records only when every stored field matches exactly
- Automatically validates each extracted URL and appends validation fields into the same markdown report
- Reuses validation results for duplicate resolved URLs so the same target is not fetched repeatedly
- Resolves `/` and other root-relative URLs against the sitemap domain
- Marks non-web schemes such as `mailto:`, `tel:`, `javascript:`, `sms:`, `data:`, and fragment-only URLs as `not_applicable`
- Logs suspicious anchor tags and fetch failures in separate report sections

## Install

```bash
npm install
```

## Run

Generate the extraction report and validate extracted URLs in the same run:

```bash
node src/index.js --sitemap https://piquant.ie/sitemap.xml --out ./reports
```

Optional flags:

- `--concurrency 1` (default)
- `--out ./reports`
- `--debug true` → only the first 30 sitemap page URLs are processed

## Output

The generated extraction markdown file contains:

1. Report metadata, including when the report was generated
2. A top-level validation summary with counts by status and unique resolved URLs checked
3. A `Link Data` section with one record per link
4. Per-link validation fields:
   - `Resolved URL`
   - `URL Validation Status`
   - `Final URL`
   - `HTTP Status`
   - `Validation Notes`
5. A `Faulty Tags` section with one record per issue
6. A `Fetch Errors` section with one record per failed page


## Validation statuses

The in-report validation step can currently classify links as:

- `valid`
- `redirected_valid`
- `not_found`
- `soft_404`
- `third_party_404`
- `server_error`
- `blocked`
- `timeout`
- `dns_error`
- `connection_error`
- `invalid_url`
- `not_applicable`

## Notes

- This version parses server-returned HTML, not a browser-rendered DOM.
- HTML parsers often repair malformed markup, so faulty tag detection uses a raw-source heuristic pass.
- `Full Raw Tag` is taken from the parsed anchor node serialization, which may differ slightly from original source on malformed HTML.
- Validation uses HTTP requests with redirect following plus simple soft-404 heuristics based on response content.
