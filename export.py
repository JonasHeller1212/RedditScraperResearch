import json
import os

import pandas as pd


DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def export_json(posts, filename="posts_full.json"):
    path = os.path.join(DATA_DIR, filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(posts, f, indent=2, ensure_ascii=False)
    print(f"Exported JSON: {path} ({len(posts)} posts)")
    return path


def export_posts_csv(posts, filename="posts.csv"):
    rows = []
    for p in posts:
        rows.append({
            "id": p["id"],
            "title": p["title"],
            "selftext": p["selftext"],
            "author": p["author"],
            "created_datetime": p["created_datetime"],
            "score": p["score"],
            "upvote_ratio": p["upvote_ratio"],
            "num_comments": p["num_comments"],
            "permalink": p["permalink"],
            "link_flair_text": p.get("link_flair_text", ""),
            "relevance_score": p.get("relevance_score", 0),
            "matched_categories": ", ".join(p.get("matched_categories", [])),
            "matched_keywords": json.dumps(p.get("matched_keywords", {})),
        })

    df = pd.DataFrame(rows)
    path = os.path.join(DATA_DIR, filename)
    df.to_csv(path, index=False, encoding="utf-8")
    print(f"Exported posts CSV: {path} ({len(rows)} rows)")
    return path


def export_comments_csv(posts, filename="comments.csv"):
    rows = []
    for p in posts:
        for c in p.get("comments", []):
            rows.append({
                "comment_id": c["id"],
                "post_id": p["id"],
                "post_title": p["title"],
                "body": c["body"],
                "author": c["author"],
                "created_datetime": c["created_datetime"],
                "score": c["score"],
                "parent_id": c["parent_id"],
                "is_submitter": c["is_submitter"],
                "relevance_score": c.get("relevance_score", 0),
                "matched_categories": ", ".join(c.get("matched_categories", [])),
                "matched_keywords": json.dumps(c.get("matched_keywords", {})),
            })

    df = pd.DataFrame(rows)
    path = os.path.join(DATA_DIR, filename)
    df.to_csv(path, index=False, encoding="utf-8")
    print(f"Exported comments CSV: {path} ({len(rows)} rows)")
    return path


def export_all(posts):
    os.makedirs(DATA_DIR, exist_ok=True)
    export_json(posts)
    export_posts_csv(posts)
    export_comments_csv(posts)
