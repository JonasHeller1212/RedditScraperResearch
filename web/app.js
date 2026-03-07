// Theme toggle
(function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
    });
  });
})();

// Default keyword categories (optional — only used when keyword analysis is enabled)
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

// --- Sort pill toggles ---
document.querySelectorAll("#sortPills .pill").forEach((pill) => {
  pill.addEventListener("click", () => pill.classList.toggle("active"));
});

// --- Keyword toggle ---
const enableKeywords = document.getElementById("enableKeywords");
const keywordsPanel = document.getElementById("keywordsPanel");

enableKeywords.addEventListener("change", () => {
  keywordsPanel.classList.toggle("hidden", !enableKeywords.checked);
  if (enableKeywords.checked && editorsContainer.children.length === 0) {
    for (const [name, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
      createKeywordEditor(name, keywords);
    }
  }
});

// --- Keyword Editors ---
const editorsContainer = document.getElementById("keyword-editors");

function createKeywordEditor(name, keywords) {
  const div = document.createElement("div");
  div.className = "keyword-editor";
  div.innerHTML = `
    <div class="keyword-editor-header">
      <input type="text" class="category-name" value="${escapeHtml(name)}" />
      <button class="remove-category" title="Remove category">Remove</button>
    </div>
    <textarea class="category-keywords">${keywords.join("\n")}</textarea>
  `;
  div.querySelector(".remove-category").addEventListener("click", () => div.remove());
  editorsContainer.appendChild(div);
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

function buildSummary(posts, keywordsEnabled) {
  const totalComments = posts.reduce((sum, p) => sum + (p.comments?.length || 0), 0);
  const totalScore = posts.reduce((sum, p) => sum + (p.score || 0), 0);

  const summary = {
    total_posts: posts.length,
    total_comments: totalComments,
    total_score: totalScore,
  };

  if (keywordsEnabled) {
    summary.posts_with_keyword_matches = posts.filter((p) => (p.relevance_score || 0) > 0).length;
    const categoryCounts = {};
    for (const p of posts) {
      for (const cat of p.matched_categories || []) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
    }
    summary.posts_per_category = categoryCounts;
  }

  return summary;
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
    progressFill.style.width = `${Math.min(percent, 100)}%`;
  }
}

scrapeBtn.addEventListener("click", async () => {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) {
    showError("Please enter a subreddit name or URL.");
    return;
  }

  const sortModes = Array.from(document.querySelectorAll("#sortPills .pill.active")).map(
    (p) => p.dataset.value
  );
  if (sortModes.length === 0) {
    showError("Please select at least one sort mode.");
    return;
  }

  const limit = parseInt(document.getElementById("limit").value, 10) || 50;
  const includeComments = document.getElementById("includeComments").checked;
  const includeSelftext = document.getElementById("includeSelftext").checked;
  const skipNSFW = document.getElementById("skipNSFW").checked;
  const keywordsEnabled = document.getElementById("enableKeywords").checked;
  const timeFilter = document.getElementById("timeFilter").value;
  const customKeywords = keywordsEnabled ? getCustomKeywords() : {};
  const categories = Object.keys(customKeywords).length > 0 ? customKeywords : DEFAULT_KEYWORDS;

  const batchSize = includeComments ? 10 : 100;
  const totalTarget = limit * sortModes.length;

  // UI state
  abortController = new AbortController();
  progressSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  scrapeBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  progressFill.style.width = "0%";
  updateProgress("Starting scrape...");

  try {
    const allPosts = [];
    const seenIds = new Set();

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
          subreddit,
          sort: mode,
          batchSize: Math.min(batchSize, limit - modeFetched),
          after,
          includeComments,
          skipIds: Array.from(seenIds),
          timeFilter: mode === "top" ? timeFilter : undefined,
        });

        let newPosts = batchResp.posts.filter((p) => !seenIds.has(p.id));

        // Apply NSFW filter client-side
        if (skipNSFW) {
          newPosts = newPosts.filter((p) => !p.over_18);
        }

        // Strip selftext if not wanted
        if (!includeSelftext) {
          newPosts.forEach((p) => { p.selftext = ""; });
        }

        for (const p of newPosts) {
          seenIds.add(p.id);
          allPosts.push(p);
          modeFetched++;
        }

        if (batchResp.done || newPosts.length === 0) break;
        after = batchResp.after;
      }
    }

    // Keyword analysis (optional)
    if (keywordsEnabled) {
      updateProgress("Running keyword analysis...", 95);
      for (const post of allPosts) {
        analyzePost(post, categories);
      }
    }

    updateProgress("Done!", 100);

    scrapeResult = {
      subreddit,
      posts: allPosts,
      keywordsEnabled,
      summary: buildSummary(allPosts, keywordsEnabled),
    };

    showResults(scrapeResult);
  } catch (err) {
    if (err.name === "AbortError") {
      updateProgress("Stopped by user.", null);
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
    <div class="stat-card"><div class="value">${s.total_posts.toLocaleString()}</div><div class="label">Posts</div></div>
    <div class="stat-card"><div class="value">${s.total_comments.toLocaleString()}</div><div class="label">Comments</div></div>
    <div class="stat-card"><div class="value">${s.total_score.toLocaleString()}</div><div class="label">Total score</div></div>
  `;
  if (s.posts_with_keyword_matches !== undefined) {
    statsHtml += `<div class="stat-card"><div class="value">${s.posts_with_keyword_matches}</div><div class="label">Keyword matches</div></div>`;
  }
  if (s.posts_per_category) {
    for (const [cat, count] of Object.entries(s.posts_per_category)) {
      statsHtml += `<div class="stat-card"><div class="value">${count}</div><div class="label">${formatCategory(cat)}</div></div>`;
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
      <h3><a href="${p.permalink}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a></h3>
      <div class="meta">u/${escapeHtml(p.author)} &middot; ${p.score} pts &middot; ${p.num_comments} comments &middot; ${new Date(p.created_datetime).toLocaleDateString()}</div>
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

// --- Computed columns for analysis ---
function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function toDateParts(isoString) {
  if (!isoString) return { date: "", day_of_week: "", hour: "" };
  const d = new Date(isoString);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return {
    date: d.toISOString().slice(0, 10),
    day_of_week: days[d.getUTCDay()],
    hour: d.getUTCHours(),
  };
}

// --- Download Handlers ---
document.getElementById("downloadJson").addEventListener("click", () => {
  if (!scrapeResult) return;
  downloadFile(
    JSON.stringify(scrapeResult.posts, null, 2),
    `reddit_${scrapeResult.subreddit}_full.json`,
    "application/json"
  );
});

document.getElementById("downloadCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = postsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_posts.csv`, "text/csv");
});

document.getElementById("downloadCommentsCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = commentsToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
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

function postsToCSV(posts, keywordsEnabled) {
  const headers = [
    "id", "subreddit", "title", "selftext", "author",
    "created_utc", "created_datetime", "date", "day_of_week", "hour_utc",
    "score", "upvote_ratio", "num_comments", "permalink",
    "link_flair_text", "title_word_count", "selftext_word_count",
    "title_char_count", "selftext_char_count", "comment_count_actual",
  ];
  if (keywordsEnabled) {
    headers.push("relevance_score", "matched_categories", "matched_keywords");
  }

  const rows = posts.map((p) => {
    const dp = toDateParts(p.created_datetime);
    const row = {
      id: p.id,
      subreddit: scrapeResult.subreddit,
      title: p.title,
      selftext: p.selftext,
      author: p.author,
      created_utc: p.created_utc,
      created_datetime: p.created_datetime,
      date: dp.date,
      day_of_week: dp.day_of_week,
      hour_utc: dp.hour,
      score: p.score,
      upvote_ratio: p.upvote_ratio,
      num_comments: p.num_comments,
      permalink: p.permalink,
      link_flair_text: p.link_flair_text || "",
      title_word_count: wordCount(p.title),
      selftext_word_count: wordCount(p.selftext),
      title_char_count: (p.title || "").length,
      selftext_char_count: (p.selftext || "").length,
      comment_count_actual: (p.comments || []).length,
    };
    if (keywordsEnabled) {
      row.relevance_score = p.relevance_score || 0;
      row.matched_categories = (p.matched_categories || []).join("; ");
      row.matched_keywords = JSON.stringify(p.matched_keywords || {});
    }
    return headers.map((h) => csvEscape(row[h])).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

function commentsToCSV(posts, keywordsEnabled) {
  const headers = [
    "comment_id", "post_id", "subreddit", "post_title",
    "body", "author", "created_utc", "created_datetime",
    "date", "day_of_week", "hour_utc",
    "score", "parent_id", "is_submitter",
    "body_word_count", "body_char_count",
  ];
  if (keywordsEnabled) {
    headers.push("relevance_score", "matched_categories", "matched_keywords");
  }

  const rows = [];
  for (const p of posts) {
    for (const c of p.comments || []) {
      const dp = toDateParts(c.created_datetime);
      const row = {
        comment_id: c.id,
        post_id: p.id,
        subreddit: scrapeResult.subreddit,
        post_title: p.title,
        body: c.body,
        author: c.author,
        created_utc: c.created_utc,
        created_datetime: c.created_datetime,
        date: dp.date,
        day_of_week: dp.day_of_week,
        hour_utc: dp.hour,
        score: c.score,
        parent_id: c.parent_id,
        is_submitter: c.is_submitter,
        body_word_count: wordCount(c.body),
        body_char_count: (c.body || "").length,
      };
      if (keywordsEnabled) {
        row.relevance_score = c.relevance_score || 0;
        row.matched_categories = (c.matched_categories || []).join("; ");
        row.matched_keywords = JSON.stringify(c.matched_keywords || {});
      }
      rows.push(headers.map((h) => csvEscape(row[h])).join(","));
    }
  }

  return [headers.join(","), ...rows].join("\n");
}
