# Reddit AI Relationships Scraper

Scrapes posts and comments from [r/MyBoyfriendIsAI](https://www.reddit.com/r/MyBoyfriendIsAI/) to research how people discuss AI usage in romantic relationships — including hidden AI companionship, emotional attachment, partner conflicts, and AI dependency.

## Features

- Scrapes posts + full comment trees via Reddit's official API (PRAW)
- Deduplicates across multiple sort modes (hot, new, top)
- Keyword-based relevance analysis across 4 research categories
- Exports to both CSV (for spreadsheets) and JSON (for programmatic use)

## Setup

### 1. Get Reddit API Credentials (free)

1. Log into Reddit and go to https://www.reddit.com/prefs/apps
2. Scroll down and click **"create another app..."**
3. Fill in:
   - **name**: anything (e.g., `ai-relationships-scraper`)
   - **type**: select **script**
   - **redirect uri**: `http://localhost:8080`
4. Click **"create app"**
5. Copy:
   - **client ID**: the string under your app name (e.g., `a1b2c3d4e5f6g7`)
   - **client secret**: the string labeled "secret"

### 2. Install Dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure Credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your Reddit API credentials:

```
REDDIT_CLIENT_ID=your_client_id_here
REDDIT_CLIENT_SECRET=your_client_secret_here
REDDIT_USER_AGENT=MyBoyfriendIsAI-Scraper/1.0
```

## Usage

```bash
# Quick test with 10 posts
python main.py --limit 10

# Full scrape (all sort modes, up to 1000 posts each)
python main.py --limit 1000

# Scrape only "top" posts
python main.py --sort top --limit 500

# Scrape without keyword analysis
python main.py --limit 100 --skip-analysis
```

## Output

All files are saved to the `data/` directory:

| File | Description |
|------|-------------|
| `posts_full.json` | Full nested data (posts + comments + analysis) |
| `posts.csv` | Flat table of posts with relevance scores |
| `comments.csv` | Flat table of all comments with post references |

## Keyword Categories

Posts and comments are scored against these research categories:

- **hiding_secrecy** — hiding, secret, doesn't know, found out, caught, etc.
- **emotional_attachment** — love, feelings, emotional support, companion, bond, etc.
- **partner_conflict** — jealous, cheating, break up, confronted, ultimatum, etc.
- **ai_dependency** — addicted, can't stop, obsessed, replacement, dependency, etc.

Edit `config.py` to customize keywords or add new categories.
