// 多平台共享类型定义。

export type PlatformKey = "xhs" | "douyin" | "mp";

export const PLATFORM_LABEL: Record<PlatformKey, string> = {
  xhs: "小红书",
  douyin: "抖音",
  mp: "公众号",
};

export const PLATFORM_COLOR: Record<PlatformKey, "danger" | "default" | "success"> = {
  xhs: "danger",
  douyin: "default",
  mp: "success",
};

export type SectionKey = "posts" | "trending" | "creators";

export const SECTION_LABEL: Record<SectionKey, string> = {
  posts: "监控帖子",
  trending: "热门内容",
  creators: "博主追新",
};

// 各平台支持的 section（公众号没有 trending）
export const PLATFORM_SECTIONS: Record<PlatformKey, SectionKey[]> = {
  xhs: ["posts", "trending", "creators"],
  douyin: ["posts", "trending", "creators"],
  mp: ["posts", "creators"],
};

export type PostRow = {
  note_id: string;
  title?: string;
  note_url?: string;
  short_url?: string;
  author?: string | null;
  liked_count?: number | null;
  collected_count?: number | null;
  comment_count?: number | null;
  share_count?: number | null;
  checked_at?: string | null;
  last_fetch_status?: string;
  fail_count?: number;
  platform?: string;
  group_name?: string | null;
  account_name?: string | null;
  summary?: string | null;
  copyright_stat?: string | null;
};

export type CreatorRow = {
  id: number;
  user_id?: number;
  platform: string;
  creator_url: string;
  creator_name?: string;
  last_check_at?: string | null;
  last_post_id?: string | null;
  is_active?: number;
  // 健康度 + 未读（后端 v2）
  last_check_status?: "ok" | "no_account" | "cookie_invalid" | "no_extension" | "ext_login_required" | "error" | "unknown" | null;
  last_check_error?: string | null;
  last_post_at?: string | null;
  unread_count?: number | null;
  last_seen_at?: string | null;
  // P9: per-creator 设置 + 卡片信息
  push_enabled?: number | boolean | null;
  fetch_interval_minutes?: number | null;
  avatar_url?: string | null;
  last_post_title?: string | null;
};

export type TrendingPost = {
  note_id: string;
  title: string;
  note_url: string;
  cover_url?: string;
  author?: string;
  liked_count?: number;
  collected_count?: number;
  comment_count?: number;
  found_at?: string;
  keyword?: string;
  platform?: string;
  desc_text?: string;
  video_url?: string;
};
