// Reddit scraper serverless function for Netlify
// Supports both public JSON endpoints and OAuth API

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Try multiple base URLs — old.reddit.com is less aggressively blocked
const BASE_URLS = [
  "https://old.reddit.com",
  "https://www.reddit.com",
];

// OAuth state (cached across invocations in the same Lambda container)
let oauthToken = null;
let oauthExpiry = 0;

async function getOAuthToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Reuse token if still valid
  if (oauthToken && Date.now() < oauthExpiry) return oauthToken;

  try {
    const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "LemonSqueeze/1.0",
      },
      body: "grant_type=client_credentials",
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    oauthToken = data.access_token;
    // Expire 60s early to be safe
    oauthExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return oauthToken;
  } catch {
    return null;
  }
}

async function fetchWithOAuth(url, token) {
  // OAuth requests go to oauth.reddit.com
  const oauthUrl = url.replace(/https:\/\/(old|www)\.reddit\.com/, "https://oauth.reddit.com");
  const resp = await fetch(oauthUrl, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "User-Agent": "LemonSqueeze/1.0",
    },
  });

  if (!resp.ok) {
    throw new Error(`OAuth request failed (${resp.status})`);
  }
  return resp.json();
}

const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

async function fetchWithRetry(url, options = {}, retries = 3) {
  // Strategy 1: Try OAuth if credentials are configured
  const token = await getOAuthToken();
  if (token) {
    try {
      return await fetchWithOAuth(url, token);
    } catch {
      // Fall through to public endpoints
    }
  }

  // Strategy 2: Try public JSON endpoints with browser-like headers
  for (const baseUrl of BASE_URLS) {
    const targetUrl = url.replace(/https:\/\/(old|www)\.reddit\.com/, baseUrl);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const resp = await fetch(targetUrl, {
          ...options,
          headers: {
            ...BROWSER_HEADERS,
            ...options.headers,
          },
        });

        if (resp.status === 429) {
          const wait = 2 ** (attempt + 1) * 1000;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (resp.status === 403) {
          // This base URL is blocked, try the next one
          break;
        }

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Reddit error (${resp.status}): ${text.slice(0, 200)}`);
        }

        const text = await resp.text();
        try {
          return JSON.parse(text);
        } catch {
          // Got HTML instead of JSON (blocked page) — try next base URL
          break;
        }
      } catch (err) {
        if (err.message.startsWith("Reddit error")) throw err;
        // Network error, retry
        if (attempt === retries - 1) break;
        await new Promise((r) => setTimeout(r, 2 ** (attempt + 1) * 1000));
      }
    }
  }

  throw new Error(
    "Reddit is blocking requests from this server. " +
    "To fix this, set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET environment variables in Netlify. " +
    "Get free credentials at reddit.com/prefs/apps (create a 'script' type app)."
  );
}

async function fetchListing(subreddit, sort, limit, after = null, timeFilter = "all") {
  let url = `https://old.reddit.com/r/${subreddit}/${sort}.json?limit=${Math.min(limit, 100)}&raw_json=1`;
  if (sort === "top") url += `&t=${timeFilter}`;
  if (after) url += `&after=${after}`;
  return fetchWithRetry(url);
}

async function fetchComments(subreddit, postId) {
  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?raw_json=1&limit=500&depth=10`;
  try {
    const data = await fetchWithRetry(url);
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
  } catch {
    return [];
  }
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
    const effectiveBatch = Math.min(includeComments ? batchSize : Math.min(batchSize, 100), 100);

    const listing = await fetchListing(parsedSubreddit, sort, effectiveBatch, after, timeFilter);

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
        post.comments = await fetchComments(parsedSubreddit, post.id);
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
    // Truncate error messages to avoid sending huge HTML dumps to the client
    const message = err.message.length > 500 ? err.message.slice(0, 500) + "…" : err.message;
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: message }),
    };
  }
}
