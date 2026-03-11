// Reddit scraper serverless function for Netlify
// Uses Reddit's free .json endpoints — no authentication required

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchReddit(url, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // 429 and 403 are both used by Reddit for rate limiting
    if (resp.status === 429 || resp.status === 403) {
      if (attempt < retries - 1) {
        const wait = 3000 * 2 ** attempt; // 3s, 6s, 12s, 24s
        await delay(wait);
        continue;
      }
      // On final attempt for 403, check if it's actually a private sub vs rate limit
      if (resp.status === 403) {
        throw new Error("Reddit blocked this request (403). This is usually temporary rate limiting — wait a minute and try again. If the subreddit is private, it cannot be accessed.");
      }
      throw new Error("Reddit rate-limited this request. Please wait a minute and try again.");
    }

    if (resp.status === 404) {
      throw new Error("Subreddit or post not found. Check the name/URL and try again.");
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (attempt < retries - 1) {
        const wait = 3000 * 2 ** attempt;
        await delay(wait);
        continue;
      }
      const snippet = text.length > 200 ? text.slice(0, 200) + "…" : text;
      throw new Error(`Reddit API error (${resp.status}): ${snippet}`);
    }

    return resp.json();
  }

  throw new Error("Reddit rate-limited this request. Please wait a minute and try again.");
}

async function fetchSubmissions(subreddit, size, after = null, sort = "new", timeFilter = "all") {
  const params = new URLSearchParams({ limit: String(Math.min(size, 100)), raw_json: "1" });

  // Time filter applies to top and controversial sorts
  if ((sort === "top" || sort === "controversial") && timeFilter) {
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
    return parseCommentTree(children, 0);
  } catch {
    return [];
  }
}

// Scrape a single thread: returns the post + all comments
async function scrapeThread(subreddit, postId) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments/${postId}.json?limit=500&depth=10&raw_json=1`;
  const data = await fetchReddit(url);

  if (!data || !Array.isArray(data) || data.length < 2) {
    throw new Error("Could not load this thread. The post may have been deleted or the URL is invalid.");
  }

  // First element is the post listing
  const postChildren = data[0]?.data?.children || [];
  if (postChildren.length === 0) {
    throw new Error("Post not found in thread response.");
  }

  const post = mapPost(postChildren[0]);

  // Second element is the comment listing
  const commentChildren = data[1]?.data?.children || [];
  post.comments = parseCommentTree(commentChildren, 0);

  return post;
}

function parseCommentTree(children, depth) {
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
      depth: depth,
      edited: d.edited ? (typeof d.edited === "number" ? d.edited : true) : false,
      distinguished: d.distinguished || null,
      controversiality: d.controversiality || 0,
    });

    // Recurse into replies
    const replies = d.replies;
    if (replies && typeof replies === "object" && replies.data) {
      const replyChildren = replies.data.children || [];
      comments.push(...parseCommentTree(replyChildren, depth + 1));
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
    edited: p.edited ? (typeof p.edited === "number" ? p.edited : true) : false,
    distinguished: p.distinguished || null,
    is_crosspost: !!(p.crosspost_parent),
    crosspost_subreddit: p.crosspost_parent_list?.[0]?.subreddit || "",
    total_awards_received: p.total_awards_received || 0,
    gilded: p.gilded || 0,
    comments: [],
  };
}

async function analyzeSubreddit(subreddit) {
  // Fetch subreddit info
  const aboutUrl = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/about.json?raw_json=1`;
  const aboutData = await fetchReddit(aboutUrl);
  const sub = aboutData?.data || {};

  const info = {
    name: sub.display_name || subreddit,
    title: sub.title || "",
    subscribers: sub.subscribers || 0,
    active_users: sub.accounts_active || 0,
    created_utc: sub.created_utc || 0,
    description: (sub.public_description || "").slice(0, 200),
    over18: sub.over18 || false,
  };

  // Light probe: only check "new" to confirm subreddit has posts (1 request instead of 7)
  // We assume all standard sorts are available if the subreddit has any posts at all
  const probes = [];
  let hasAnyPosts = false;

  try {
    await delay(1000); // breathing room after about.json
    const { children } = await fetchSubmissions(subreddit, 1, null, "new", "all");
    hasAnyPosts = children.length > 0;
  } catch {
    hasAnyPosts = false;
  }

  // All sorts available by default if subreddit has posts — no need to probe each one
  const allSorts = [
    { sort: "new", timeFilter: "all", label: "New" },
    { sort: "top", timeFilter: "all", label: "Top (All Time)" },
    { sort: "hot", timeFilter: "all", label: "Hot" },
    { sort: "controversial", timeFilter: "all", label: "Controversial" },
    { sort: "rising", timeFilter: "all", label: "Rising" },
  ];

  for (const cfg of allSorts) {
    probes.push({
      sort: cfg.sort,
      timeFilter: cfg.timeFilter,
      label: cfg.label,
      available: hasAnyPosts,
      estimatedMax: hasAnyPosts ? (cfg.sort === "rising" ? 100 : 1000) : 0,
    });
  }

  const availableSorts = probes.filter((p) => p.available);
  // Conservative estimate: each sort up to 1000, with ~50% overlap between sorts
  const estimated = hasAnyPosts
    ? Math.min(availableSorts.length * 700, 4000)
    : 0;

  return {
    info,
    probes,
    estimatedTotalUnique: estimated,
    sortConfigs: availableSorts,
  };
}

// --- URL parsing helpers ---
function parseRedditInput(input) {
  const trimmed = (input || "").trim();

  // Check if it's a post/thread URL: reddit.com/r/sub/comments/id/...
  const threadMatch = trimmed.match(/reddit\.com\/r\/([^/?\s]+)\/comments\/([^/?\s]+)/);
  if (threadMatch) {
    return { type: "thread", subreddit: threadMatch[1], postId: threadMatch[2] };
  }

  // Check if it's a subreddit URL: reddit.com/r/sub
  const subMatch = trimmed.match(/reddit\.com\/r\/([^/?\s]+)/);
  if (subMatch) {
    return { type: "subreddit", subreddit: subMatch[1] };
  }

  // Plain text — strip r/ prefix if present
  const plain = trimmed.replace(/^r\//, "");
  if (plain) {
    return { type: "subreddit", subreddit: plain };
  }

  return { type: "invalid" };
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

    // Handle analyze action
    if (body.action === "analyze") {
      const parsed = parseRedditInput(body.subreddit);
      if (parsed.type === "thread") {
        // For thread URLs, return thread info instead of subreddit analysis
        const post = await scrapeThread(parsed.subreddit, parsed.postId);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            type: "thread",
            subreddit: parsed.subreddit,
            post,
          }),
        };
      }
      if (parsed.type === "invalid" || !parsed.subreddit) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
      }
      const analysis = await analyzeSubreddit(parsed.subreddit);
      return { statusCode: 200, headers, body: JSON.stringify({ type: "subreddit", ...analysis }) };
    }

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
