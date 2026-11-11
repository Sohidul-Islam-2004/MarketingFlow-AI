// Talking to the server. Every function throws an Error with the server's message if something fails.

export async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("Can't reach the server. Check your internet and try again."); });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === "LOGIN_REQUIRED") window.dispatchEvent(new Event("logged-out"));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const get = (url) => api(url);
export const post = (url, body = {}) => api(url, { method: "POST", body });
export const put = (url, body = {}) => api(url, { method: "PUT", body });
export const del = (url) => api(url, { method: "DELETE" });

// Upload photos/videos. Returns the saved media records.
export async function uploadFiles(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  const res = await fetch("/api/media", { method: "POST", credentials: "same-origin", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}
