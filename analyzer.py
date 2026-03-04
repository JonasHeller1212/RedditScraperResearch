import re
from collections import defaultdict

from config import KEYWORD_CATEGORIES


def _find_keyword_matches(text, categories=None):
    if categories is None:
        categories = KEYWORD_CATEGORIES

    if not text:
        return {}, 0

    text_lower = text.lower()
    matched = {}

    for category, keywords in categories.items():
        hits = []
        for kw in keywords:
            if re.search(r'\b' + re.escape(kw) + r'\b', text_lower):
                hits.append(kw)
        if hits:
            matched[category] = hits

    score = sum(len(hits) for hits in matched.values())
    return matched, score


def analyze_post(post):
    combined_text = f"{post['title']} {post['selftext']}"
    matched, score = _find_keyword_matches(combined_text)
    post["matched_keywords"] = matched
    post["relevance_score"] = score
    post["matched_categories"] = list(matched.keys())

    for comment in post.get("comments", []):
        c_matched, c_score = _find_keyword_matches(comment["body"])
        comment["matched_keywords"] = c_matched
        comment["relevance_score"] = c_score
        comment["matched_categories"] = list(c_matched.keys())

    return post


def analyze_all(posts):
    return [analyze_post(p) for p in posts]


def summarize(posts):
    total_posts = len(posts)
    total_comments = sum(len(p.get("comments", [])) for p in posts)

    posts_with_matches = [p for p in posts if p.get("relevance_score", 0) > 0]
    comments_with_matches = sum(
        1 for p in posts for c in p.get("comments", []) if c.get("relevance_score", 0) > 0
    )

    category_counts = defaultdict(int)
    for p in posts:
        for cat in p.get("matched_categories", []):
            category_counts[cat] += 1

    top_posts = sorted(posts, key=lambda p: p.get("relevance_score", 0), reverse=True)[:10]

    return {
        "total_posts": total_posts,
        "total_comments": total_comments,
        "posts_with_keyword_matches": len(posts_with_matches),
        "comments_with_keyword_matches": comments_with_matches,
        "posts_per_category": dict(category_counts),
        "top_relevant_posts": [
            {"title": p["title"], "score": p["relevance_score"], "url": p["permalink"]}
            for p in top_posts
        ],
    }
