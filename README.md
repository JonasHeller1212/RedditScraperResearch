# LemonSqueeze — Reddit Scraper

A web app that scrapes posts and comments from any subreddit and exports them as CSV or JSON. I built this to make it easier to collect Reddit data for research without dealing with API keys or authentication headaches.

## What it does

- Scrapes posts and full comment threads from any public subreddit
- Supports multiple sort modes (new, top, hot) in a single run
- Deduplicates posts across sort modes so you don't get repeats
- Optional keyword analysis — define your own categories and score posts by relevance
- Exports to CSV (opens right in Excel/Google Sheets) and JSON (for Python/R scripts)
- Everything runs in the browser, nothing gets stored on a server

## How it works

The frontend is a static site hosted on Netlify. When you hit "Squeeze," it sends requests to a serverless function that pulls data from PullPush.io (a public Reddit data mirror). Posts come back to the browser where they get processed, analyzed (if you turned on keywords), and packaged into downloadable files.

No Reddit API credentials needed. No account setup. Just enter a subreddit and go.

## Running locally

You need Node.js and the Netlify CLI:

```bash
npm install -g netlify-cli
netlify dev
```

This starts a local dev server at `http://localhost:8888` with the serverless functions wired up.

## Deploying

The app deploys to Netlify. Push to main and it picks up changes automatically (or run `netlify deploy --prod` manually).

The config lives in `netlify.toml` — it publishes the `web/` folder and bundles the functions from `netlify/functions/`.

## Project structure

```
web/
  index.html    — the UI
  app.js        — scraping logic, keyword analysis, CSV/JSON export
  style.css     — styling
  favicon.svg   — lemon icon

netlify/
  functions/
    scrape.mjs  — serverless function that talks to PullPush.io
```

## Keyword analysis (optional)

If you turn on keyword analysis in the UI, you can define categories with lists of keywords. Each post and comment gets scored by how many keywords it matches. The scores and matched categories show up as extra columns in the CSV export.

You can customize the categories to whatever you're researching — the defaults are just examples.

## Limits

- PullPush.io caps requests at 100 results per call and has rate limits (~15 requests/min)
- Very large scrapes (thousands of posts with comments) will take a while since each post's comments need a separate request
- PullPush mirrors Reddit data with some delay, so the very latest posts might not show up immediately
