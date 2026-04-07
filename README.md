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
- Logs suspicious anchor tags and fetch failures in separate report sections

## Install

```bash
npm install
```

## Run

Create the extraction report:

```bash
node src/index.js --sitemap https://piquant.ie/sitemap.xml --out ./reports
```

Validate unique extracted URLs from an existing report:

```bash
node src/index.js --validate-from ./reports/piquant.ie-data.md --out ./reports
```

Optional flags:

- `--concurrency 4`
- `--out ./reports`

## Output

The generated extraction markdown file contains:

1. A `Link Data` section with one record per link
2. A `Faulty Tags` section with one record per issue
3. A `Fetch Errors` section with one record per failed page

The generated validation markdown file contains:

1. One validation record per unique absolute HTTP(S) URL
2. HTTP status and status text
3. Final URL after redirects
4. Any fetch error if the validation request failed

## Notes

- This version parses server-returned HTML, not a browser-rendered DOM.
- HTML parsers often repair malformed markup, so faulty tag detection uses a raw-source heuristic pass.
- `Full Raw Tag` is taken from the parsed anchor node serialization, which may differ slightly from original source on malformed HTML.
