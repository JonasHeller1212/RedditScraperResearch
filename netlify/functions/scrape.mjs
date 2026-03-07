// Reddit scraper serverless function for Netlify
// Uses PullPush.io API — free Reddit data mirror, no authentication required

const USER_AGENT = "LemonSqueeze/1.0 (research scraper)";

async function fetchPullPush(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (resp.status === 429) {
      const wait = 2 ** (attempt + 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      // Only include first 200 chars of error body to avoid HTML dumps
      const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
      throw new Error(`PullPush API error (${resp.status}): ${snippet}`);
    }

    return resp.json();
  }

  throw new Error("PullPush API rate limit exceeded. Please try again in a minute.");
}

async function fetchSubmissions(subreddit, size, before = null, sort = "new", timeFilter = "all") {
  let url = `https://api.pullpush.io/reddit/search/submission/?subreddit=${encodeURIComponent(subreddit)}&size=${Math.min(size, 100)}`;

  // PullPush sort: "desc" (newest first) or "asc" (oldest first)
  // For "new" sort, we want newest first
  // For "top" sort, we sort by score client-side after fetching
  url += `&sort=desc&sort_type=created_utc`;

  if (before) {
    url += `&before=${before}`;
  }

  // For "top" sort with time filter, limit the time range
  if (sort === "top" && timeFilter !== "all") {
    const now = Math.floor(Date.now() / 1000);
    const ranges = {
      day: 86400,
      week: 604800,
      month: 2592000,
      year: 31536000,
    };
    if (ranges[timeFilter]) {
      url += `&after=${now - ranges[timeFilter]}`;
    }
  }

  const data = await fetchPullPush(url);
  return Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
}

async function fetchComments(postId) {
  // PullPush uses the full "t3_" prefixed link_id for comment search
  const url = `https://api.pullpush.io/reddit/search/comment/?link_id=${encodeURIComponent(postId)}&size=100&sort=desc&sort_type=created_utc`;

  try {
    const data = await fetchPullPush(url);
    const items = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

    return items.map((c) => ({
      id: c.id || "",
      body: c.body || "",
      author: c.author || "[deleted]",
      created_utc: c.created_utc || 0,
      created_datetime: c.created_utc ? new Date(c.created_utc * 1000).toISOString() : "",
      score: c.score || 0,
      parent_id: c.parent_id || "",
      is_submitter: c.is_submitter || false,
    }));
  } catch {
    return [];
  }
}

function mapPost(p) {
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
    permalink: p.permalink
      ? `https://reddit.com${p.permalink}`
      : p.id
        ? `https://reddit.com/r/${p.subreddit}/comments/${p.id}`
        : "",
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

    // PullPush uses Unix timestamp for pagination (the `after` param from client
    // is repurposed: first call it's null, subsequent calls it's the `created_utc`
    // of the last post we returned — we pass it as `before` to PullPush)
    const submissions = await fetchSubmissions(
      parsedSubreddit,
      effectiveBatch,
      after,  // This is the `before` timestamp for PullPush pagination
      sort,
      timeFilter
    );

    if (!submissions || submissions.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ posts: [], after: null, done: true }),
      };
    }

    // If sorting by "top", sort by score descending
    if (sort === "top") {
      submissions.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    // Map all posts first (skip duplicates)
    const posts = [];
    let lastCreatedUtc = null;

    for (const raw of submissions) {
      if (!raw.id) continue;
      if (seenIds.has(raw.id)) continue;

      const post = mapPost(raw);
      lastCreatedUtc = raw.created_utc;
      posts.push(post);
    }

    // Fetch comments in parallel batches of 5 to stay within timeout
    if (includeComments) {
      const PARALLEL = 5;
      const postsWithComments = posts.filter((p) => p.num_comments > 0);
      for (let i = 0; i < postsWithComments.length; i += PARALLEL) {
        const batch = postsWithComments.slice(i, i + PARALLEL);
        const results = await Promise.all(batch.map((p) => fetchComments(p.id)));
        for (let j = 0; j < batch.length; j++) {
          batch[j].comments = results[j];
        }
      }
    }

    // For pagination: if we got a full batch, use the last post's created_utc as cursor
    const done = submissions.length < effectiveBatch;
    const nextAfter = done ? null : lastCreatedUtc;

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
