// Meta Graph API client: GET params go in the URL, POST bodies are sent as JSON.
const { META } = require("../config");
const { fail } = require("./errors");

const GRAPH = `https://graph.facebook.com/${META.GRAPH_VERSION}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${META.GRAPH_VERSION}`;

async function graph(path, { token, params = {}, method = "GET", body, base = GRAPH } = {}) {
  const url = new URL(path.startsWith("http") ? path : base + path);
  for (const [k, v] of Object.entries({ ...params, access_token: token })) {
    if (v != null) url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const options = { method, signal: AbortSignal.timeout(60000) }; // give up after 60s instead of hanging
  if (body && method !== "GET") {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options).catch((e) => { throw fail(502, e.name === "TimeoutError" ? "Facebook took too long to answer" : "Could not reach Facebook"); });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw fail(502, e.error_user_msg || e.message || `Facebook API error ${res.status}`);
  }
  return json;
}

// Follows "paging.next" links and returns all rows (up to max)
async function graphAll(path, options = {}, max = 500) {
  let page = await graph(path, options);
  const rows = [...(page.data || [])];
  while (page.paging?.next && rows.length < max) {
    page = await graph(page.paging.next);
    rows.push(...(page.data || []));
  }
  return rows;
}

module.exports = { graph, graphAll, GRAPH, GRAPH_VIDEO };
