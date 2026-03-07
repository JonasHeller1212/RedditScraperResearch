// Reddit scraper serverless function for Netlify
// Uses Reddit's free .json endpoints — no authentication required

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchReddit(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (resp.status === 429) {
      const wait = 2000 * 2 ** attempt;
      await delay(wait);
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (attempt < retries - 1) {
        const wait = 2000 * 2 ** attempt;
        await delay(wait);
        continue;
      }
      const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
      throw new Error(`Reddit API error (${resp.status}): ${snippet}`);
    }

    return resp.json();
  }

  throw new Error("Reddit API rate limit exceeded. Please try again in a minute.");
}

async function fetchSubmissions(subreddit, size, after = null, sort = "new", timeFilter = "all") {
  const params = new URLSearchParams({ limit: String(Math.min(size, 100)), raw_json: "1" });

  if (sort === "top" && timeFilter) {
    params.set("t", timeFilter);
  }

  if (after) {
    params.set("after", after);
  }

  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?${params}`;
  const data = await fetchReddit(url);

  const children = data?.data?.children || [];
  const nextAfter = data?.data?.after || null;

  return { children, nextAfter };
}

async function fetchComments(postId, subreddit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${postId}.json?limit=500&depth=10&raw_json=1`;

  try {
    const data = await fetchReddit(url);
    if (!data || !Array.isArray(data) || data.length < 2) return [];

    const children = data[1]?.data?.children || [];
    return parseCommentTree(children);
  } catch {
    return [];
  }
}

function parseCommentTree(children) {
  const comments = [];
  if (!children) return comments;

  for (const child of children) {
    if (child?.kind !== "t1") continue;

    const d = child.data || {};
    comments.push({
      id: d.id || "",
      body: d.body || "",
      author: d.author || "[deleted]",
      created_utc: d.created_utc || 0,
      created_datetime: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
      score: d.score || 0,
      parent_id: d.parent_id || "",
      is_submitter: d.is_submitter || false,
    });

    // Recurse into replies
    const replies = d.replies;
    if (replies && typeof replies === "object" && replies.data) {
      const replyChildren = replies.data.children || [];
      comments.push(...parseCommentTree(replyChildren));
    }
  }
  return comments;
}

function mapPost(child) {
  const p = child.data || child;
  const permalink = p.permalink || "";
  return {
    id: p.id || "",
    title: p.title || "",
    selftext: p.selftext || "",
    author: p.author || "[deleted]",
    created_utc: p.created_utc || 0,
    created_datetime: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : "",
    score: p.score || 0,
    upvote_ratio: p.upvote_ratio || 0,
    num_comments: p.num_comments || 0,
    url: p.url || "",
    permalink: permalink ? `https://reddit.com${permalink}` : "",
    link_flair_text: p.link_flair_text || "",
    over_18: p.over_18 || false,
    comments: [],
  };
}

export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body);
    const {
      subreddit,
      sort = "new",
      batchSize = 25,
      after = null,
      includeComments = true,
      skipIds = [],
      timeFilter = "all",
    } = body;

    let parsedSubreddit = (subreddit || "").trim();
    const urlMatch = parsedSubreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) parsedSubreddit = urlMatch[1];
    parsedSubreddit = parsedSubreddit.replace(/^r\//, "");

    if (!parsedSubreddit) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
    }

    const seenIds = new Set(skipIds);
    const effectiveBatch = Math.min(batchSize, 100);

    // `after` is Reddit's cursor string (e.g. "t3_abc123") or null for first page
    const { children, nextAfter } = await fetchSubmissions(
      parsedSubreddit,
      effectiveBatch,
      after,
      sort,
      timeFilter,
    );

    if (!children || children.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ posts: [], after: null, done: true }),
      };
    }

    // Map posts, skip duplicates
    const posts = [];
    for (const child of children) {
      const d = child.data || {};
      if (!d.id) continue;
      if (seenIds.has(d.id)) continue;

      const post = mapPost(child);
      posts.push(post);
    }

    // Fetch comments in parallel batches of 3 with delay between batches
    if (includeComments) {
      const PARALLEL = 3;
      const postsWithComments = posts.filter((p) => p.num_comments > 0);
      for (let i = 0; i < postsWithComments.length; i += PARALLEL) {
        if (i > 0) await delay(1500);
        const batch = postsWithComments.slice(i, i + PARALLEL);
        const results = await Promise.all(
          batch.map((p) => fetchComments(p.id, parsedSubreddit)),
        );
        for (let j = 0; j < batch.length; j++) {
          batch[j].comments = results[j];
        }
      }
    }

    // Reddit provides cursor-based pagination via `after` field
    const done = !nextAfter;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        posts,
        after: nextAfter,
        done,
      }),
    };
  } catch (err) {
    const message = err.message.length > 500 ? err.message.slice(0, 500) + "…" : err.message;
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: message }),
    };
  }
}
