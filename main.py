import argparse
import json

from scraper import scrape_posts
from analyzer import analyze_all, summarize
from export import export_all
from config import SORT_MODES


def main():
    parser = argparse.ArgumentParser(description="Scrape r/MyBoyfriendIsAI for AI relationship research")
    parser.add_argument("--limit", type=int, default=1000, help="Max posts per sort mode (default: 1000)")
    parser.add_argument(
        "--sort", default="all",
        help="Sort mode: hot, new, top, or 'all' for all modes (default: all)",
    )
    parser.add_argument("--skip-analysis", action="store_true", help="Skip keyword analysis")
    args = parser.parse_args()

    sort_modes = SORT_MODES if args.sort == "all" else [args.sort]

    print("=== Reddit AI Relationships Scraper ===\n")

    print("[1/3] Scraping posts and comments...")
    posts = scrape_posts(limit=args.limit, sort_modes=sort_modes)
    print(f"\nScraped {len(posts)} unique posts.\n")

    if not args.skip_analysis:
        print("[2/3] Analyzing keyword relevance...")
        posts = analyze_all(posts)
        summary = summarize(posts)

        print(f"\n--- Summary ---")
        print(f"Total posts: {summary['total_posts']}")
        print(f"Total comments: {summary['total_comments']}")
        print(f"Posts with keyword matches: {summary['posts_with_keyword_matches']}")
        print(f"Comments with keyword matches: {summary['comments_with_keyword_matches']}")
        print(f"\nPosts per category:")
        for cat, count in summary["posts_per_category"].items():
            print(f"  {cat}: {count}")
        print(f"\nTop 10 most relevant posts:")
        for i, p in enumerate(summary["top_relevant_posts"], 1):
            print(f"  {i}. [score={p['score']}] {p['title'][:70]}")
            print(f"     {p['url']}")
        print()
    else:
        print("[2/3] Skipping analysis.\n")

    print("[3/3] Exporting data...")
    export_all(posts)

    print("\nDone! Check the data/ directory for output files.")


if __name__ == "__main__":
    main()
