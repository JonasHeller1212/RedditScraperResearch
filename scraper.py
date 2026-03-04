import os
from datetime import datetime, timezone

import praw
from dotenv import load_dotenv

from config import SUBREDDIT, DEFAULT_POST_LIMIT, SORT_MODES


def create_reddit_client():
    load_dotenv()
    client_id = os.getenv("REDDIT_CLIENT_ID")
    client_secret = os.getenv("REDDIT_CLIENT_SECRET")
    user_agent = os.getenv("REDDIT_USER_AGENT", "MyBoyfriendIsAI-Scraper/1.0")

    if not client_id or not client_secret:
        raise ValueError(
            "Missing Reddit API credentials. "
            "Copy .env.example to .env and fill in your REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET."
        )

    return praw.Reddit(
        client_id=client_id,
        client_secret=client_secret,
        user_agent=user_agent,
    )


def _extract_comment(comment):
    return {
        "id": comment.id,
        "body": comment.body,
        "author": str(comment.author) if comment.author else "[deleted]",
        "created_utc": comment.created_utc,
        "created_datetime": datetime.fromtimestamp(comment.created_utc, tz=timezone.utc).isoformat(),
        "score": comment.score,
        "parent_id": comment.parent_id,
        "is_submitter": comment.is_submitter,
    }


def _extract_post(post):
    return {
        "id": post.id,
        "title": post.title,
        "selftext": post.selftext,
        "author": str(post.author) if post.author else "[deleted]",
        "created_utc": post.created_utc,
        "created_datetime": datetime.fromtimestamp(post.created_utc, tz=timezone.utc).isoformat(),
        "score": post.score,
        "upvote_ratio": post.upvote_ratio,
        "num_comments": post.num_comments,
        "url": post.url,
        "permalink": f"https://reddit.com{post.permalink}",
        "link_flair_text": post.link_flair_text,
    }


def scrape_comments(post):
    post.comments.replace_more(limit=None)
    return [_extract_comment(c) for c in post.comments.list()]


def scrape_posts(reddit, subreddit_name=SUBREDDIT, limit=DEFAULT_POST_LIMIT, sort_modes=None):
    if sort_modes is None:
        sort_modes = SORT_MODES

    subreddit = reddit.subreddit(subreddit_name)
    seen_ids = set()
    posts = []

    for mode in sort_modes:
        print(f"  Fetching '{mode}' posts from r/{subreddit_name}...")

        if mode == "new":
            listing = subreddit.new(limit=limit)
        elif mode == "top":
            listing = subreddit.top(time_filter="all", limit=limit)
        elif mode == "hot":
            listing = subreddit.hot(limit=limit)
        else:
            print(f"  Unknown sort mode '{mode}', skipping.")
            continue

        count = 0
        for post in listing:
            if post.id in seen_ids:
                continue
            seen_ids.add(post.id)

            post_data = _extract_post(post)
            print(f"    [{len(posts) + 1}] {post_data['title'][:80]}")

            post_data["comments"] = scrape_comments(post)
            posts.append(post_data)
            count += 1

        print(f"  Got {count} new posts from '{mode}' (total unique: {len(posts)})")

    return posts
