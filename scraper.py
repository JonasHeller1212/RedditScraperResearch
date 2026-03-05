import time
from datetime import datetime, timezone

import requests

from config import SUBREDDIT, DEFAULT_POST_LIMIT, SORT_MODES

HEADERS = {
    "User-Agent": "MyBoyfriendIsAI-Scraper/1.0 (research; no auth)",
}
BASE_URL = "https://www.reddit.com"


def _get_json(url, params=None, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
            if resp.status_code == 429:
                wait = 2 ** (attempt + 1)
                print(f"    Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"    Request failed ({e}), retrying in {wait}s...")
                time.sleep(wait)
            else:
                raise
    return None


def _extract_comment(comment_data):
    d = comment_data.get("data", {})
    created = d.get("created_utc", 0)
    return {
        "id": d.get("id", ""),
        "body": d.get("body", ""),
        "author": d.get("author", "[deleted]"),
        "created_utc": created,
        "created_datetime": datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else "",
        "score": d.get("score", 0),
        "parent_id": d.get("parent_id", ""),
        "is_submitter": d.get("is_submitter", False),
    }


def _extract_post(post_data):
    d = post_data.get("data", {})
    created = d.get("created_utc", 0)
    permalink = d.get("permalink", "")
    return {
        "id": d.get("id", ""),
        "title": d.get("title", ""),
        "selftext": d.get("selftext", ""),
        "author": d.get("author", "[deleted]"),
        "created_utc": created,
        "created_datetime": datetime.fromtimestamp(created, tz=timezone.utc).isoformat() if created else "",
        "score": d.get("score", 0),
        "upvote_ratio": d.get("upvote_ratio", 0),
        "num_comments": d.get("num_comments", 0),
        "url": d.get("url", ""),
        "permalink": f"https://reddit.com{permalink}" if permalink else "",
        "link_flair_text": d.get("link_flair_text"),
    }


def _parse_comment_tree(children):
    comments = []
    if not children:
        return comments
    for child in children:
        if child.get("kind") != "t1":
            continue
        comments.append(_extract_comment(child))
        replies = child.get("data", {}).get("replies")
        if isinstance(replies, dict):
            reply_children = replies.get("data", {}).get("children", [])
            comments.extend(_parse_comment_tree(reply_children))
    return comments


def scrape_comments(post_id, subreddit_name=SUBREDDIT):
    url = f"{BASE_URL}/r/{subreddit_name}/comments/{post_id}.json"
    data = _get_json(url, params={"limit": 500, "depth": 10})
    if not data or len(data) < 2:
        return []
    children = data[1].get("data", {}).get("children", [])
    return _parse_comment_tree(children)


def scrape_posts(subreddit_name=SUBREDDIT, limit=DEFAULT_POST_LIMIT, sort_modes=None):
    if sort_modes is None:
        sort_modes = SORT_MODES

    seen_ids = set()
    posts = []

    for mode in sort_modes:
        print(f"  Fetching '{mode}' posts from r/{subreddit_name}...")

        params = {"limit": min(limit, 100)}
        if mode == "top":
            params["t"] = "all"

        url = f"{BASE_URL}/r/{subreddit_name}/{mode}.json"
        after = None
        count = 0
        fetched = 0

        while fetched < limit:
            if after:
                params["after"] = after

            data = _get_json(url, params=params)
            if not data:
                break

            children = data.get("data", {}).get("children", [])
            if not children:
                break

            for child in children:
                post_data = child.get("data", {})
                post_id = post_data.get("id")
                if not post_id or post_id in seen_ids:
                    continue
                seen_ids.add(post_id)

                extracted = _extract_post(child)
                print(f"    [{len(posts) + 1}] {extracted['title'][:80]}")

                extracted["comments"] = scrape_comments(post_id, subreddit_name)
                posts.append(extracted)
                count += 1

            after = data.get("data", {}).get("after")
            if not after:
                break
            fetched += len(children)

            # Be polite with rate limiting
            time.sleep(1)

        print(f"  Got {count} new posts from '{mode}' (total unique: {len(posts)})")

    return posts
