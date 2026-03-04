// Default keyword categories (matching config.py)
const DEFAULT_KEYWORDS = {
  hiding_secrecy: [
    "hiding", "hidden", "secret", "secretly", "don't tell", "doesn't know",
    "didn't tell", "found out", "caught", "discovered", "behind my back",
    "cover up", "lie about", "lied about", "lying about", "not telling",
    "private", "incognito", "delete history", "clear history",
  ],
  emotional_attachment: [
    "love", "in love", "feelings", "emotional support", "comfort",
    "companion", "companionship", "attached", "attachment", "bond",
    "connection", "intimate", "intimacy", "affection", "caring",
    "understanding", "listens to me", "always there", "never judges",
    "safe space", "vulnerability", "vulnerable",
  ],
  partner_conflict: [
    "jealous", "jealousy", "cheating", "upset", "angry", "furious",
    "broke up", "break up", "breakup", "confronted", "argument",
    "fight", "fighting", "disgusted", "uncomfortable", "weird",
    "controlling", "ultimatum", "divorce", "betrayal", "betrayed",
    "suspicious", "caught me", "found my phone",
  ],
  ai_dependency: [
    "addicted", "addiction", "can't stop", "obsessed", "obsession",
    "need him", "need her", "need it", "depend", "dependent", "dependency",
    "replacement", "replacing", "prefer", "better than", "more than human",
    "hours a day", "all day", "every day", "withdraw", "withdrawal",
  ],
};

let scrapeResult = null;
let abortController = null;

// --- Collapsible Sections ---
document.querySelectorAll(".toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const target = document.getElementById(toggle.dataset.target);
    const isOpen = !target.classList.contains("collapsed");
    target.classList.toggle("collapsed", isOpen);
    toggle.classList.toggle("open", !isOpen);
  });
});

// --- Keyword Editors ---
const editorsContainer = document.getElementById("keyword-editors");

function createKeywordEditor(name, keywords) {
  const div = document.createElement("div");
  div.className = "keyword-editor";
  div.innerHTML = `
    <div class="keyword-editor-header">
      <input type="text" class="category-name" value="${name}" />
      <button class="remove-category" title="Remove category">Remove</button>
    </div>
    <textarea class="category-keywords">${keywords.join("\n")}</textarea>
  `;
  div.querySelector(".remove-category").addEventListener("click", () => div.remove());
  editorsContainer.appendChild(div);
}

for (const [name, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
  createKeywordEditor(name, keywords);
}

document.getElementById("addCategoryBtn").addEventListener("click", () => {
  createKeywordEditor("new_category", []);
});

function getCustomKeywords() {
  const editors = editorsContainer.querySelectorAll(".keyword-editor");
  const categories = {};
  editors.forEach((editor) => {
    const name = editor.querySelector(".category-name").value.trim();
    const keywords = editor
      .querySelector(".category-keywords")
      .value.split("\n")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (name && keywords.length > 0) {
      categories[name] = keywords;
    }
  });
  return categories;
}

// --- Keyword Analysis (client-side) ---
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findKeywordMatches(text, categories) {
  if (!text) return { matched: {}, score: 0 };
  const textLower = text.toLowerCase();
  const matched = {};

  for (const [category, keywords] of Object.entries(categories)) {
    const hits = [];
    for (const kw of keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(textLower)) {
        hits.push(kw);
      }
    }
    if (hits.length > 0) {
      matched[category] = hits;
    }
  }

  const score = Object.values(matched).reduce((sum, hits) => sum + hits.length, 0);
  return { matched, score };
}

function analyzePost(post, categories) {
  const combinedText = `${post.title} ${post.selftext}`;
  const { matched, score } = findKeywordMatches(combinedText, categories);
  post.matched_keywords = matched;
  post.relevance_score = score;
  post.matched_categories = Object.keys(matched);

  for (const comment of post.comments || []) {
    const cm = findKeywordMatches(comment.body, categories);
    comment.matched_keywords = cm.matched;
    comment.relevance_score = cm.score;
    comment.matched_categories = Object.keys(cm.matched);
  }
  return post;
}

function buildSummary(posts) {
  const totalComments = posts.reduce((sum, p) => sum + (p.comments?.length || 0), 0);
  const postsWithMatches = posts.filter((p) => (p.relevance_score || 0) > 0).length;
  const commentsWithMatches = posts.reduce(
    (sum, p) => sum + (p.comments || []).filter((c) => (c.relevance_score || 0) > 0).length,
    0
  );
  const categoryCounts = {};
  for (const p of posts) {
    for (const cat of p.matched_categories || []) {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
  }
  const topPosts = [...posts]
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .slice(0, 10)
    .map((p) => ({ title: p.title, score: p.relevance_score, url: p.permalink }));

  return {
    total_posts: posts.length,
    total_comments: totalComments,
    posts_with_keyword_matches: postsWithMatches,
    comments_with_keyword_matches: commentsWithMatches,
    posts_per_category: categoryCounts,
    top_relevant_posts: topPosts,
  };
}

// --- Scrape Orchestration ---
const scrapeBtn = document.getElementById("scrapeBtn");
const stopBtn = document.getElementById("stopBtn");
const progressSection = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const statusText = document.getElementById("statusText");
const resultsSection = document.getElementById("results");
const errorSection = document.getElementById("error");
const errorText = document.getElementById("errorText");

async function apiCall(body) {
  const resp = await fetch("/api/scrape", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abortController?.signal,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Server error (${resp.status})`);
  return data;
}

function updateProgress(message, percent = null) {
  statusText.textContent = message;
  if (percent !== null) {
    progressFill.className = "progress-fill";
    progressFill.style.width = `${Math.min(percent, 100)}%`;
  }
}

scrapeBtn.addEventListener("click", async () => {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) {
    showError("Please enter a subreddit name or URL.");
    return;
  }

  const sortModes = Array.from(document.querySelectorAll(".checkbox-group input:checked")).map(
    (cb) => cb.value
  );
  if (sortModes.length === 0) {
    showError("Please select at least one sort mode.");
    return;
  }

  const limit = parseInt(document.getElementById("limit").value, 10) || 50;
  const includeComments = document.getElementById("includeComments").checked;
  const skipAnalysis = document.getElementById("skipAnalysis").checked;
  const clientId = document.getElementById("clientId").value.trim() || null;
  const clientSecret = document.getElementById("clientSecret").value.trim() || null;
  const customKeywords = getCustomKeywords();
  const categories =
    Object.keys(customKeywords).length > 0 ? customKeywords : DEFAULT_KEYWORDS;

  // Batch size: smaller when fetching comments (each needs an API call)
  const batchSize = includeComments ? 25 : 100;
  const totalTarget = limit * sortModes.length; // rough target across all modes

  // UI state
  abortController = new AbortController();
  progressSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  scrapeBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  progressFill.className = "progress-fill";
  progressFill.style.width = "0%";
  updateProgress("Authenticating with Reddit...");

  try {
    // Step 1: Get auth token
    const authResp = await apiCall({
      action: "auth",
      clientId,
      clientSecret,
    });
    const token = authResp.token;

    // Step 2: Batch-scrape each sort mode
    const allPosts = [];
    const seenIds = new Set();

    // Parse subreddit name from URL
    let subreddit = subredditInput;
    const urlMatch = subreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) subreddit = urlMatch[1];
    subreddit = subreddit.replace(/^r\//, "");

    for (let modeIdx = 0; modeIdx < sortModes.length; modeIdx++) {
      const mode = sortModes[modeIdx];
      let after = null;
      let modeFetched = 0;

      while (modeFetched < limit) {
        const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
        const overallFetched = allPosts.length;
        const percent = (overallFetched / totalTarget) * 100;
        updateProgress(
          `Fetching "${modeLabel}" posts from r/${subreddit}... (${overallFetched} posts so far)`,
          percent
        );

        const batchResp = await apiCall({
          action: "batch",
          token,
          subreddit,
          sort: mode,
          batchSize: Math.min(batchSize, limit - modeFetched),
          after,
          includeComments,
          skipIds: Array.from(seenIds),
        });

        const newPosts = batchResp.posts.filter((p) => !seenIds.has(p.id));
        for (const p of newPosts) {
          seenIds.add(p.id);
          allPosts.push(p);
          modeFetched++;
        }

        // Stop if Reddit has no more pages or we got nothing new
        if (batchResp.done || newPosts.length === 0) break;
        after = batchResp.after;
      }
    }

    // Step 3: Keyword analysis (client-side — instant, no timeout)
    if (!skipAnalysis) {
      updateProgress("Analyzing keywords...", 95);
      for (const post of allPosts) {
        analyzePost(post, categories);
      }
    }

    updateProgress("Done!", 100);

    scrapeResult = {
      subreddit,
      posts: allPosts,
      summary: buildSummary(allPosts),
    };

    showResults(scrapeResult);
  } catch (err) {
    if (err.name === "AbortError") {
      updateProgress("Stopped by user.", null);
      // Still show partial results if we have any
      if (scrapeResult || (allPosts && allPosts.length > 0)) {
        // scrapeResult may not be set yet, build from whatever we have
      }
    } else {
      showError(err.message);
      progressSection.classList.add("hidden");
    }
  } finally {
    scrapeBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    abortController = null;
  }
});

// Stop button
stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

function showError(msg) {
  errorSection.classList.remove("hidden");
  errorText.textContent = msg;
}

function showResults(data) {
  resultsSection.classList.remove("hidden");
  const s = data.summary;

  const summaryDiv = document.getElementById("summary");
  let statsHtml = `
    <div class="stat"><div class="value">${s.total_posts}</div><div class="label">Posts scraped</div></div>
    <div class="stat"><div class="value">${s.total_comments}</div><div class="label">Comments collected</div></div>
  `;
  if (s.posts_with_keyword_matches !== undefined) {
    statsHtml += `
      <div class="stat"><div class="value">${s.posts_with_keyword_matches}</div><div class="label">Posts with keyword matches</div></div>
      <div class="stat"><div class="value">${s.comments_with_keyword_matches}</div><div class="label">Comments with keyword matches</div></div>
    `;
  }
  if (s.posts_per_category && Object.keys(s.posts_per_category).length > 0) {
    for (const [cat, count] of Object.entries(s.posts_per_category)) {
      statsHtml += `<div class="stat"><div class="value">${count}</div><div class="label">${formatCategory(cat)}</div></div>`;
    }
  }
  summaryDiv.innerHTML = statsHtml;

  // Preview
  const previewDiv = document.getElementById("preview");
  const previewPosts = data.posts.slice(0, 5);
  previewDiv.innerHTML = previewPosts
    .map(
      (p) => `
    <div class="preview-post">
      <h3><a href="${p.permalink}" target="_blank">${escapeHtml(p.title)}</a></h3>
      <div class="meta">by ${escapeHtml(p.author)} | Score: ${p.score} | ${p.num_comments} comments | ${new Date(p.created_datetime).toLocaleDateString()}</div>
      ${
        p.matched_categories && p.matched_categories.length > 0
          ? `<div class="categories">${p.matched_categories.map((c) => `<span class="badge">${formatCategory(c)}</span>`).join("")}</div>`
          : ""
      }
    </div>
  `
    )
    .join("");
}

function formatCategory(cat) {
  return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// --- Download Buttons ---
document.getElementById("downloadJson").addEventListener("click", () => {
  if (!scrapeResult) return;
  downloadFile(
    JSON.stringify(scrapeResult.posts, null, 2),
    `reddit_${scrapeResult.subreddit}_full.json`,
    "application/json"
  );
});

document.getElementById("downloadPostsCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = postsToCSV(scrapeResult.posts);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_posts.csv`, "text/csv");
});

document.getElementById("downloadCommentsCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = commentsToCSV(scrapeResult.posts);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_comments.csv`, "text/csv");
});

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function postsToCSV(posts) {
  const headers = [
    "id", "title", "selftext", "author", "created_datetime",
    "score", "upvote_ratio", "num_comments", "permalink",
    "link_flair_text", "relevance_score", "matched_categories", "matched_keywords",
  ];
  const rows = posts.map((p) =>
    headers.map((h) => {
      if (h === "matched_categories") return csvEscape((p[h] || []).join(", "));
      if (h === "matched_keywords") return csvEscape(JSON.stringify(p[h] || {}));
      return csvEscape(p[h]);
    }).join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

function commentsToCSV(posts) {
  const headers = [
    "comment_id", "post_id", "post_title", "body", "author",
    "created_datetime", "score", "parent_id", "is_submitter",
    "relevance_score", "matched_categories", "matched_keywords",
  ];
  const rows = [];
  for (const p of posts) {
    for (const c of p.comments || []) {
      rows.push(
        [
          csvEscape(c.id),
          csvEscape(p.id),
          csvEscape(p.title),
          csvEscape(c.body),
          csvEscape(c.author),
          csvEscape(c.created_datetime),
          csvEscape(c.score),
          csvEscape(c.parent_id),
          csvEscape(c.is_submitter),
          csvEscape(c.relevance_score || 0),
          csvEscape((c.matched_categories || []).join(", ")),
          csvEscape(JSON.stringify(c.matched_keywords || {})),
        ].join(",")
      );
    }
  }
  return [headers.join(","), ...rows].join("\n");
}
