// SWR-based shared data hooks. Only the high-frequency endpoints used across
// multiple pages are wrapped here — page-specific fetches stay as-is.
"use client";

import useSWR, { mutate as globalMutate, SWRConfiguration } from "swr";
import { useAuth } from "@/contexts/AuthContext";

type FetcherKey = [string, string]; // [url, token]

// Common fetcher with Authorization header. 401 → drop token + redirect /login.
const fetcher = async ([url, token]: FetcherKey) => {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      try { localStorage.removeItem("token"); } catch {}
      // 仅在不在登录/注册页时跳走，避免循环
      const path = window.location.pathname;
      if (path !== "/login" && path !== "/register") {
        window.location.replace("/login");
      }
    }
    throw new Error("401 Unauthorized");
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

// Defaults：focus revalidate 关闭，dedupe 30s；keepPreviousData 让导航时立即显示旧数据
const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  dedupingInterval: 30000,
  shouldRetryOnError: false,
  keepPreviousData: true,
};

// 通用 hook — 给一个绝对路径，自动带 token
export function useApi<T = any>(path: string | null, config?: SWRConfiguration) {
  const { token } = useAuth();
  const key: FetcherKey | null = path && token ? [path, token] : null;
  return useSWR<T>(key, fetcher, { ...defaultConfig, ...config });
}

// ── 5 个共享 hook ──────────────────────────────────────────────

// /api/auth/me
export type Me = {
  id: number;
  username: string;
  email?: string;
  role?: "user" | "admin";
  plan?: string;
  trial_ends_at?: string | null;
  mp_auth_uin?: string | null;
  mp_auth_key?: string | null;
  mp_auth_at?: string | null;
  mp_auth_status?: "valid" | "expired" | "unknown" | null;
  [k: string]: any;
};
export const useMe = () => useApi<Me>("/api/auth/me");
export const mutateMe = () => globalMutate((k) => Array.isArray(k) && k[0] === "/api/auth/me");

// /api/monitor/accounts
export type Account = { id: number; name: string; [k: string]: any };
export const useAccounts = () => {
  const swr = useApi<{ accounts: Account[] }>("/api/monitor/accounts");
  return { ...swr, accounts: swr.data?.accounts ?? [] };
};
export const mutateAccounts = () =>
  globalMutate((k) => Array.isArray(k) && k[0] === "/api/monitor/accounts");

// /api/monitor/groups
export type Group = { id: number; name: string; is_builtin: number; platform?: string; [k: string]: any };
export const useGroups = (platform?: "xhs" | "douyin" | "mp") => {
  const path = platform ? `/api/monitor/groups?platform=${platform}` : "/api/monitor/groups";
  const swr = useApi<{ groups: Group[] }>(path);
  return { ...swr, groups: swr.data?.groups ?? [] };
};
export const mutateGroups = () =>
  globalMutate((k) => Array.isArray(k) && String(k[0]).startsWith("/api/monitor/groups"));

// /api/monitor/settings
export const useSettings = <T = Record<string, string>>() =>
  useApi<T>("/api/monitor/settings");
export const mutateSettings = () =>
  globalMutate((k) => Array.isArray(k) && k[0] === "/api/monitor/settings");

// /api/monitor/prompts
export type Prompt = { id: number; name: string; content: string; is_default?: number };
export const usePrompts = () => {
  const swr = useApi<{ prompts: Prompt[] }>("/api/monitor/prompts");
  return { ...swr, prompts: swr.data?.prompts ?? [] };
};
export const mutatePrompts = () =>
  globalMutate((k) => Array.isArray(k) && k[0] === "/api/monitor/prompts");

// /api/monitor/posts（全量；各页面自行 client-side filter platform）
// 缓存 30s，导航立即显示旧数据，后台 revalidate
export type PostRow = {
  note_id: string; title: string; platform?: string;
  liked_count?: number | null; collected_count?: number | null;
  comment_count?: number | null; checked_at?: string | null;
  short_url?: string; note_url?: string; group_id?: number | null;
  group_name?: string | null; last_fetch_status?: string;
  last_fetch_at?: string | null; fail_count?: number;
  [k: string]: any;
};
export const usePosts = () => {
  const swr = useApi<{ posts: PostRow[] }>("/api/monitor/posts", { dedupingInterval: 30000 });
  return { ...swr, posts: swr.data?.posts ?? [] };
};
export const mutatePosts = () =>
  globalMutate((k) => Array.isArray(k) && k[0] === "/api/monitor/posts");

// /api/monitor/alerts（最近 30 条）；?platform=xhs|douyin|mp 按平台隔离
export type AlertRow = {
  id: number; note_id: string; title: string;
  alert_type: string; message: string; created_at: string;
  platform?: string;
};
export const useAlerts = (limit = 30, platform?: "xhs" | "douyin" | "mp") => {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (platform) qs.set("platform", platform);
  const url = `/api/monitor/alerts?${qs.toString()}`;
  const swr = useApi<{ alerts: AlertRow[] }>(url, { dedupingInterval: 30000 });
  return { ...swr, alerts: swr.data?.alerts ?? [] };
};
export const mutateAlerts = () =>
  globalMutate((k) => Array.isArray(k) && typeof k[0] === "string" && k[0].startsWith("/api/monitor/alerts"));

// ── P15: AI 模型 ──────────────────────────────────────────────
// 用户可见模型 + 自己的偏好（用于改写 / 商品图 modal 里的「选择模型」下拉）
export type AiModelOption = {
  id: number;
  model_id: string;
  display_name: string;
  usage_type: "text" | "image";
  provider_name: string;
  is_default: number;
  extra_config: Record<string, any>;
};
export type AiModelsResp = {
  models: AiModelOption[];
  preferred_text_model_id: number | null;
  preferred_image_model_id: number | null;
};
export const useAiModels = (usage: "text" | "image") => {
  const swr = useApi<AiModelsResp>(`/api/ai/models?usage=${usage}`, { dedupingInterval: 60000 });
  return {
    ...swr,
    models: swr.data?.models ?? [],
    preferred:
      usage === "text"
        ? swr.data?.preferred_text_model_id ?? null
        : swr.data?.preferred_image_model_id ?? null,
  };
};
export const mutateAiModels = () =>
  globalMutate((k) => Array.isArray(k) && typeof k[0] === "string" && k[0].startsWith("/api/ai/models"));
