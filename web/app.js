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
let currentAnalysis = null;

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

// --- Save/Resume system ---
const STORAGE_KEY = "lemonsqueeze_progress";

function saveProgress(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      timestamp: Date.now(),
      subreddit: data.subreddit,
      posts: data.posts,
      seenIds: Array.from(data.seenIds),
      sortQueue: data.sortQueue,
      currentSortIdx: data.currentSortIdx,
      currentAfter: data.currentAfter,
      currentModeFetched: data.currentModeFetched,
      settings: data.settings,
    }));
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Expire after 24 hours
    if (Date.now() - data.timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearProgress() {
  localStorage.removeItem(STORAGE_KEY);
}

// --- Time estimate helpers ---
function estimateTime(postCount, includeComments) {
  // Rate: ~100 posts per request, ~2s per request
  // With comments: ~10 posts per batch (each needs comment fetch), ~5s per batch
  if (includeComments) {
    const batches = Math.ceil(postCount / 10);
    const seconds = batches * 5;
    return seconds;
  } else {
    const batches = Math.ceil(postCount / 100);
    const seconds = batches * 2;
    return seconds;
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

// --- API call helper ---
async function apiCall(body, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });
    const data = await resp.json();
    if (resp.ok) return data;

    const errMsg = data.error || `Server error (${resp.status})`;
    if (attempt < maxRetries && (resp.status === 429 || resp.status >= 500 || errMsg.includes("rate limit"))) {
      const wait = 5000 * 2 ** attempt;
      updateProgress(`Rate limited — retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(errMsg);
  }
}

// --- UI references ---
const analyzeBtn = document.getElementById("analyzeBtn");
const scrapeBtn = document.getElementById("scrapeBtn");
const stopBtn = document.getElementById("stopBtn");
const progressSection = document.getElementById("progress");
const progressFill = document.getElementById("progressFill");
const statusText = document.getElementById("statusText");
const resultsSection = document.getElementById("results");
const errorSection = document.getElementById("error");
const errorText = document.getElementById("errorText");
const analysisCard = document.getElementById("analysisCard");
const resumeBanner = document.getElementById("resumeBanner");

function updateProgress(message, percent = null) {
  statusText.textContent = message;
  if (percent !== null) {
    progressFill.style.width = `${Math.min(percent, 100)}%`;
  }
}

function showError(msg) {
  errorSection.classList.remove("hidden");
  errorText.textContent = msg;
}

// --- Analyze flow ---
analyzeBtn.addEventListener("click", async () => {
  const subredditInput = document.getElementById("subreddit").value.trim();
  if (!subredditInput) {
    showError("Please enter a subreddit name or URL.");
    return;
  }

  errorSection.classList.add("hidden");
  analysisCard.classList.add("hidden");
  resultsSection.classList.add("hidden");
  progressSection.classList.remove("hidden");
  progressFill.style.width = "0%";
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector(".btn-text").textContent = "Analyzing...";

  try {
    updateProgress("Analyzing subreddit...", 20);

    const analysis = await apiCall({ action: "analyze", subreddit: subredditInput });
    currentAnalysis = analysis;

    updateProgress("Analysis complete!", 100);

    // Show analysis card
    showAnalysis(analysis);
  } catch (err) {
    showError(err.message);
  } finally {
    progressSection.classList.add("hidden");
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector(".btn-text").textContent = "Analyze";
  }
});

function showAnalysis(analysis) {
  const { info, probes, estimatedTotalUnique } = analysis;

  document.getElementById("analysisTitle").textContent = `r/${info.name}`;
  document.getElementById("analysisDesc").textContent = info.description || info.title || "";

  const nsfwBadge = document.getElementById("analysisNsfw");
  if (info.over18) nsfwBadge.classList.remove("hidden");
  else nsfwBadge.classList.add("hidden");

  // Stats
  const ageYears = info.created_utc
    ? ((Date.now() / 1000 - info.created_utc) / (365.25 * 86400)).toFixed(1)
    : "?";

  document.getElementById("analysisStats").innerHTML = `
    <div class="stat-card"><div class="value">${info.subscribers.toLocaleString()}</div><div class="label">Subscribers</div></div>
    <div class="stat-card"><div class="value">${info.active_users.toLocaleString()}</div><div class="label">Online now</div></div>
    <div class="stat-card"><div class="value">${estimatedTotalUnique.toLocaleString()}</div><div class="label">Est. collectible posts</div></div>
    <div class="stat-card"><div class="value">${ageYears}y</div><div class="label">Community age</div></div>
  `;

  // Collection plan
  const availableSorts = probes.filter((p) => p.available);
  const includeComments = document.getElementById("includeComments").checked;
  const limit = parseInt(document.getElementById("limit").value, 10) || 50;

  // Build sort plan display
  const planSortsEl = document.getElementById("planSorts");
  planSortsEl.innerHTML = availableSorts.map((s) => `
    <div class="plan-sort-item">
      <span class="plan-sort-label">${s.label}</span>
      <span class="plan-sort-max">up to ${Math.min(s.estimatedMax, limit).toLocaleString()} posts</span>
    </div>
  `).join("");

  // Explainer
  const planExplainer = document.getElementById("planExplainer");
  if (estimatedTotalUnique > 1000) {
    planExplainer.innerHTML = `This subreddit likely has <strong>more than 1,000 posts</strong>. Reddit limits each listing to ~1,000 results, but by combining multiple sort modes and time filters we can collect up to <strong>~${estimatedTotalUnique.toLocaleString()}</strong> unique posts. Select your sort modes and post limit below, then hit Squeeze.`;
  } else {
    planExplainer.innerHTML = `We can collect posts using the sort modes below. Each mode returns up to 1,000 posts. Posts are deduplicated across modes.`;
  }

  // Time estimate
  const selectedSorts = Array.from(document.querySelectorAll("#sortPills .pill.active"));
  const totalPosts = Math.min(limit * Math.max(selectedSorts.length, 1), estimatedTotalUnique);
  const etaSeconds = estimateTime(totalPosts, includeComments);
  const planEstimate = document.getElementById("planEstimate");
  planEstimate.innerHTML = `
    <div class="estimate-row">
      <span>Estimated posts to collect:</span>
      <strong>${totalPosts.toLocaleString()}</strong>
    </div>
    <div class="estimate-row">
      <span>Estimated time${includeComments ? " (with comments)" : ""}:</span>
      <strong>${formatDuration(etaSeconds)}</strong>
    </div>
    <div class="estimate-hint">You can close this tab during collection and resume later — progress is saved automatically.</div>
  `;

  analysisCard.classList.remove("hidden");
}

// --- Scrape Orchestration ---
scrapeBtn.addEventListener("click", () => startScrape(false));

async function startScrape(isResume) {
  const saved = isResume ? loadProgress() : null;

  let subreddit, sortQueue, limit, includeComments, includeSelftext, skipNSFW;
  let keywordsEnabled, timeFilter, customKeywords, categories;
  let allPosts = [], seenIds = new Set();
  let startSortIdx = 0, startAfter = null, startModeFetched = 0;

  if (saved) {
    // Resume from saved state
    subreddit = saved.subreddit;
    allPosts = saved.posts;
    seenIds = new Set(saved.seenIds);
    sortQueue = saved.sortQueue;
    startSortIdx = saved.currentSortIdx;
    startAfter = saved.currentAfter;
    startModeFetched = saved.currentModeFetched;
    limit = saved.settings.limit;
    includeComments = saved.settings.includeComments;
    includeSelftext = saved.settings.includeSelftext;
    skipNSFW = saved.settings.skipNSFW;
    keywordsEnabled = saved.settings.keywordsEnabled;
    timeFilter = saved.settings.timeFilter;
    customKeywords = saved.settings.customKeywords;
    categories = Object.keys(customKeywords || {}).length > 0 ? customKeywords : DEFAULT_KEYWORDS;
  } else {
    // Fresh scrape
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

    limit = parseInt(document.getElementById("limit").value, 10) || 50;
    includeComments = document.getElementById("includeComments").checked;
    includeSelftext = document.getElementById("includeSelftext").checked;
    skipNSFW = document.getElementById("skipNSFW").checked;
    keywordsEnabled = document.getElementById("enableKeywords").checked;
    timeFilter = document.getElementById("timeFilter").value;
    customKeywords = keywordsEnabled ? getCustomKeywords() : {};
    categories = Object.keys(customKeywords).length > 0 ? customKeywords : DEFAULT_KEYWORDS;

    subreddit = subredditInput;
    const urlMatch = subreddit.match(/reddit\.com\/r\/([^/?\s]+)/);
    if (urlMatch) subreddit = urlMatch[1];
    subreddit = subreddit.replace(/^r\//, "");

    // Build sort queue — if >1000 posts wanted and analysis available, use multiple time filters
    sortQueue = [];
    for (const mode of sortModes) {
      if (mode === "top" && limit > 1000 && currentAnalysis) {
        // Split top across time filters for more unique results
        sortQueue.push({ sort: "top", timeFilter: "all", label: "Top (All Time)" });
        sortQueue.push({ sort: "top", timeFilter: "year", label: "Top (Year)" });
        sortQueue.push({ sort: "top", timeFilter: "month", label: "Top (Month)" });
      } else {
        sortQueue.push({ sort: mode, timeFilter: mode === "top" ? timeFilter : "all", label: mode.charAt(0).toUpperCase() + mode.slice(1) });
      }
    }
  }

  const batchSize = includeComments ? 10 : 100;
  const totalTarget = limit * sortQueue.length;

  // UI state
  abortController = new AbortController();
  progressSection.classList.remove("hidden");
  resultsSection.classList.add("hidden");
  errorSection.classList.add("hidden");
  resumeBanner.classList.add("hidden");
  scrapeBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  progressFill.style.width = "0%";
  updateProgress(isResume ? `Resuming... (${allPosts.length} posts already collected)` : "Starting squeeze...");

  const settings = { limit, includeComments, includeSelftext, skipNSFW, keywordsEnabled, timeFilter, customKeywords };

  try {
    for (let modeIdx = startSortIdx; modeIdx < sortQueue.length; modeIdx++) {
      const mode = sortQueue[modeIdx];
      let after = modeIdx === startSortIdx ? startAfter : null;
      let modeFetched = modeIdx === startSortIdx ? startModeFetched : 0;

      while (modeFetched < limit) {
        const overallFetched = allPosts.length;
        const percent = (overallFetched / totalTarget) * 100;

        // Time remaining estimate
        const remainingPosts = totalTarget - overallFetched;
        const etaStr = formatDuration(estimateTime(remainingPosts, includeComments));
        updateProgress(
          `${mode.label}: ${overallFetched} posts collected (${etaStr} remaining)`,
          percent
        );

        const batchResp = await apiCall({
          subreddit,
          sort: mode.sort,
          batchSize: Math.min(batchSize, limit - modeFetched),
          after,
          includeComments,
          skipIds: Array.from(seenIds),
          timeFilter: mode.timeFilter,
        });

        let newPosts = batchResp.posts.filter((p) => !seenIds.has(p.id));

        if (skipNSFW) {
          newPosts = newPosts.filter((p) => !p.over_18);
        }
        if (!includeSelftext) {
          newPosts.forEach((p) => { p.selftext = ""; });
        }

        for (const p of newPosts) {
          seenIds.add(p.id);
          allPosts.push(p);
          modeFetched++;
        }

        // Save progress every batch
        saveProgress({
          subreddit,
          posts: allPosts,
          seenIds,
          sortQueue,
          currentSortIdx: modeIdx,
          currentAfter: batchResp.after,
          currentModeFetched: modeFetched,
          settings,
        });

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
    clearProgress(); // Scrape complete — clear saved state

    scrapeResult = {
      subreddit,
      posts: allPosts,
      keywordsEnabled,
      summary: buildSummary(allPosts, keywordsEnabled),
    };

    showResults(scrapeResult);
  } catch (err) {
    if (err.name === "AbortError") {
      updateProgress(`Paused — ${allPosts.length} posts saved. You can close this tab and resume later.`, null);
      // Save on abort too
      saveProgress({
        subreddit,
        posts: allPosts,
        seenIds,
        sortQueue,
        currentSortIdx: startSortIdx,
        currentAfter: null,
        currentModeFetched: 0,
        settings,
      });
    } else {
      showError(err.message);
      progressSection.classList.add("hidden");
    }
  } finally {
    scrapeBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    abortController = null;
  }
}

stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

// --- Resume banner ---
function checkForSavedProgress() {
  const saved = loadProgress();
  if (!saved) return;

  const ago = Math.round((Date.now() - saved.timestamp) / 60000);
  const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;

  document.getElementById("resumeDetails").textContent =
    `r/${saved.subreddit} — ${saved.posts.length} posts collected (saved ${agoStr})`;
  resumeBanner.classList.remove("hidden");
}

document.getElementById("resumeBtn").addEventListener("click", () => {
  resumeBanner.classList.add("hidden");
  startScrape(true);
});

document.getElementById("discardBtn").addEventListener("click", () => {
  clearProgress();
  resumeBanner.classList.add("hidden");
});

// Check on page load
checkForSavedProgress();

// --- Results display ---
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

document.getElementById("downloadCombinedCsv").addEventListener("click", () => {
  if (!scrapeResult) return;
  const csv = combinedToCSV(scrapeResult.posts, scrapeResult.keywordsEnabled);
  downloadFile(csv, `reddit_${scrapeResult.subreddit}_combined.csv`, "text/csv");
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

function combinedToCSV(posts, keywordsEnabled) {
  const headers = [
    "post_id", "subreddit", "post_title", "post_selftext", "post_author",
    "post_created_utc", "post_created_datetime", "post_date", "post_day_of_week", "post_hour_utc",
    "post_score", "post_upvote_ratio", "post_num_comments", "post_permalink", "post_flair",
    "post_title_word_count", "post_selftext_word_count",
    "comment_id", "comment_body", "comment_author",
    "comment_created_utc", "comment_created_datetime", "comment_date", "comment_day_of_week", "comment_hour_utc",
    "comment_score", "comment_parent_id", "comment_is_submitter",
    "comment_body_word_count",
    "row_type",
  ];
  if (keywordsEnabled) {
    headers.push("post_relevance_score", "post_matched_categories", "post_matched_keywords",
                  "comment_relevance_score", "comment_matched_categories", "comment_matched_keywords");
  }

  const rows = [];
  for (const p of posts) {
    const pdp = toDateParts(p.created_datetime);
    const postFields = {
      post_id: p.id,
      subreddit: scrapeResult.subreddit,
      post_title: p.title,
      post_selftext: p.selftext,
      post_author: p.author,
      post_created_utc: p.created_utc,
      post_created_datetime: p.created_datetime,
      post_date: pdp.date,
      post_day_of_week: pdp.day_of_week,
      post_hour_utc: pdp.hour,
      post_score: p.score,
      post_upvote_ratio: p.upvote_ratio,
      post_num_comments: p.num_comments,
      post_permalink: p.permalink,
      post_flair: p.link_flair_text || "",
      post_title_word_count: wordCount(p.title),
      post_selftext_word_count: wordCount(p.selftext),
    };
    if (keywordsEnabled) {
      postFields.post_relevance_score = p.relevance_score || 0;
      postFields.post_matched_categories = (p.matched_categories || []).join("; ");
      postFields.post_matched_keywords = JSON.stringify(p.matched_keywords || {});
    }

    const comments = p.comments || [];
    if (comments.length === 0) {
      const row = { ...postFields, row_type: "post_only" };
      if (keywordsEnabled) {
        row.comment_relevance_score = "";
        row.comment_matched_categories = "";
        row.comment_matched_keywords = "";
      }
      rows.push(headers.map((h) => csvEscape(row[h])).join(","));
    } else {
      for (const c of comments) {
        const cdp = toDateParts(c.created_datetime);
        const row = {
          ...postFields,
          comment_id: c.id,
          comment_body: c.body,
          comment_author: c.author,
          comment_created_utc: c.created_utc,
          comment_created_datetime: c.created_datetime,
          comment_date: cdp.date,
          comment_day_of_week: cdp.day_of_week,
          comment_hour_utc: cdp.hour,
          comment_score: c.score,
          comment_parent_id: c.parent_id,
          comment_is_submitter: c.is_submitter,
          comment_body_word_count: wordCount(c.body),
          row_type: "comment",
        };
        if (keywordsEnabled) {
          row.comment_relevance_score = c.relevance_score || 0;
          row.comment_matched_categories = (c.matched_categories || []).join("; ");
          row.comment_matched_keywords = JSON.stringify(c.matched_keywords || {});
        }
        rows.push(headers.map((h) => csvEscape(row[h])).join(","));
      }
    }
  }

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
