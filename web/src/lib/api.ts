const base = (path: string) => path;

const req = async (url: string, token: string, options?: RequestInit) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

export const getWsUrl = () => {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
};

export const authApi = {
  login: (credentials: { username: string; password: string }) =>
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }).then((r) => r.json()),

  getCurrentUser: (token: string) => req("/api/auth/me", token),

  logout: (token: string) =>
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json()),
};

export const crawlerApi = {
  getStatus: (token: string) => req("/api/crawler/status", token),

  start: (token: string, payload: Record<string, unknown>) =>
    req("/api/crawler/start", token, { method: "POST", body: JSON.stringify(payload) }),

  stop: (token: string) =>
    req("/api/crawler/stop", token, { method: "POST", body: JSON.stringify({}) }),
};

export const dataApi = {
  getFiles: (token: string, platform: string, format: string) =>
    req(`/api/data/files?platform=${platform}&format=${format}`, token),

  getFileContent: (token: string, path: string, limit?: number) =>
    req(`/api/data/content?path=${encodeURIComponent(path)}${limit ? `&limit=${limit}` : ""}`, token),
};

export const publisherApi = {
  uploadImage: (token: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/publisher/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then((r) => r.json());
  },

  deleteImage: (token: string, fileId: string) =>
    fetch(`/api/publisher/images/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json()),

  searchTopic: (token: string, keyword: string) =>
    req(`/api/publisher/topics?keyword=${encodeURIComponent(keyword)}`, token),

  publishNote: (token: string, payload: Record<string, unknown>) =>
    req("/api/publisher/publish", token, { method: "POST", body: JSON.stringify(payload) }),
};
