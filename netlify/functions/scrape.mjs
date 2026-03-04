// Reddit scraper serverless function for Netlify
// Handles one batch at a time — the frontend orchestrates pagination

async function getRedditToken(clientId, clientSecret) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "RedditResearchScraper/1.0",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function fetchListing(token, subreddit, sort, limit, after = null) {
  let url = `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=${Math.min(limit, 100)}&raw_json=1`;
  if (sort === "top") url += "&t=all";
  if (after) url += `&after=${after}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "RedditResearchScraper/1.0",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit API error (${resp.status}): ${text}`);
  }

  return resp.json();
}

async function fetchComments(token, subreddit, postId) {
  const url = `https://oauth.reddit.com/r/${subreddit}/comments/${postId}?raw_json=1&limit=500&depth=10`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "RedditResearchScraper/1.0",
    },
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  if (!data[1] || !data[1].data) return [];

  const comments = [];
  function extractComments(children) {
    for (const child of children) {
      if (child.kind !== "t1") continue;
      const c = child.data;
      comments.push({
        id: c.id,
        body: c.body || "",
        author: c.author || "[deleted]",
        created_utc: c.created_utc,
        created_datetime: new Date(c.created_utc * 1000).toISOString(),
        score: c.score,
        parent_id: c.parent_id,
        is_submitter: c.is_submitter || false,
      });
      if (c.replies && c.replies.data && c.replies.data.children) {
        extractComments(c.replies.data.children);
      }
    }
  }

  extractComments(data[1].data.children);
  return comments;
}

function extractPost(postData) {
  const p = postData.data;
  return {
    id: p.id,
    title: p.title || "",
    selftext: p.selftext || "",
    author: p.author || "[deleted]",
    created_utc: p.created_utc,
    created_datetime: new Date(p.created_utc * 1000).toISOString(),
    score: p.score,
    upvote_ratio: p.upvote_ratio,
    num_comments: p.num_comments,
    url: p.url,
    permalink: `https://reddit.com${p.permalink}`,
    link_flair_text: p.link_flair_text || "",
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
      action = "batch",       // "auth" | "batch"
      subreddit,
      sort = "new",           // single sort mode per request
      batchSize = 25,         // posts per batch (with comments) or 100 (without)
      after = null,           // pagination cursor
      includeComments = true,
      skipIds = [],           // IDs already fetched (for dedup across sort modes)
      token = null,           // reuse token across batches
      clientId = null,
      clientSecret = null,
    } = body;

    // --- Action: auth --- get a token for the session
    if (action === "auth") {
      const cId = clientId || process.env.REDDIT_CLIENT_ID;
      const cSecret = clientSecret || process.env.REDDIT_CLIENT_SECRET;

      if (!cId || !cSecret) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Reddit API credentials required. Either provide your own or ask your admin to configure server credentials.",
          }),
        };
      }

      const newToken = await getRedditToken(cId, cSecret);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ token: newToken }),
      };
    }

    // --- Action: batch --- fetch one batch of posts
    if (!token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Token required. Call with action='auth' first." }) };
    }

    let parsedSubreddit = (subreddit || "").trim();
    const urlMatch = parsedSubreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) parsedSubreddit = urlMatch[1];
    parsedSubreddit = parsedSubreddit.replace(/^r\//, "");

    if (!parsedSubreddit) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subreddit name is required" }) };
    }

    const seenIds = new Set(skipIds);
    const effectiveBatch = Math.min(includeComments ? batchSize : Math.min(batchSize, 100), 100);

    // Fetch one page from Reddit (up to 100 posts per API call)
    const listing = await fetchListing(token, parsedSubreddit, sort, effectiveBatch, after);

    if (!listing.data || !listing.data.children || listing.data.children.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ posts: [], after: null, done: true }),
      };
    }

    const posts = [];
    for (const child of listing.data.children) {
      if (child.kind !== "t3") continue;
      if (seenIds.has(child.data.id)) continue;

      const post = extractPost(child);

      if (includeComments && post.num_comments > 0) {
        post.comments = await fetchComments(token, parsedSubreddit, post.id);
      }

      posts.push(post);
    }

    const nextAfter = listing.data.after || null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        posts,
        after: nextAfter,
        done: nextAfter === null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
