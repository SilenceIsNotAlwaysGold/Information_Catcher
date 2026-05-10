"use client";

/**
 * 全局 ⌘K 搜索弹窗
 * - 监听 Cmd+K / Ctrl+K（window keydown，preventDefault）
 * - debounce 250ms 调 /api/monitor/search?q=...&limit=20
 * - 三段结果：帖子 / 作者 / 直播间，每段最多 5 条
 * - 点击行 → 跳到对应平台的内部详情页（XHS posts 有 history 路由，其余跳列表）
 * - 点击外链图标 → 新 tab 打开真实平台 URL
 *
 * 暴露：
 *   - <GlobalSearch open onClose />（受控）
 *   - useGlobalSearch() → { open, openSearch, closeSearch }（含全局 ⌘K 监听副作用）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Modal,
  ModalContent,
  ModalBody,
} from "@nextui-org/modal";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import { ExternalLink, Search, FileText, User as UserIcon } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { PLATFORM_LABEL, PLATFORM_COLOR, type PlatformKey } from "@/components/platform";

// ────────────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────────────

type PostHit = {
  platform: string;
  note_id: string;
  title: string;
  url: string;
  liked_count: number;
  comment_count: number;
};

type CreatorHit = {
  platform: string;
  id: number;
  name: string;
  url: string;
};

type SearchResp = {
  posts: PostHit[];
  creators: CreatorHit[];
};

const EMPTY_RESP: SearchResp = { posts: [], creators: [] };
const SECTION_LIMIT = 5;

// 按平台决定点击进入的内部路由（保持各平台一致：进列表页）
function postInternalHref(platform: string, noteId: string): string {
  if (platform === "xhs") {
    // XHS 有 history 路由可以带 note_id 高亮（即便不识别参数也能落地到列表）
    return `/dashboard/xhs/posts/history?note_id=${encodeURIComponent(noteId)}`;
  }
  if (platform === "douyin") return `/dashboard/douyin/posts/`;
  if (platform === "mp") return `/dashboard/mp/posts/`;
  return "/dashboard";
}

function creatorInternalHref(platform: string): string {
  if (platform === "xhs") return "/dashboard/xhs/creators/";
  if (platform === "douyin") return "/dashboard/douyin/creators/";
  if (platform === "mp") return "/dashboard/mp/creators/";
  return "/dashboard";
}

function platformChip(platform: string) {
  const key = platform as PlatformKey;
  const label = PLATFORM_LABEL[key] ?? platform;
  const color = PLATFORM_COLOR[key] ?? "default";
  return (
    <Chip size="sm" variant="flat" color={color as any} className="shrink-0">
      {label}
    </Chip>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 主组件
// ────────────────────────────────────────────────────────────────────────────

export function GlobalSearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { token } = useAuth();
  const [q, setQ] = useState("");
  const [data, setData] = useState<SearchResp>(EMPTY_RESP);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 关闭时清空，下次打开是干净状态
  useEffect(() => {
    if (!open) {
      setQ("");
      setData(EMPTY_RESP);
      setLoading(false);
      if (abortRef.current) abortRef.current.abort();
    }
  }, [open]);

  // debounce 触发 fetch
  useEffect(() => {
    if (!open) return;
    const term = q.trim();

    // 清掉上一次未触发的 timer
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (term.length < 1) {
      setData(EMPTY_RESP);
      setLoading(false);
      return;
    }

    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      // 取消上一次 in-flight 请求
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const r = await fetch(
          `/api/monitor/search?q=${encodeURIComponent(term)}&limit=20`,
          { headers, signal: ctrl.signal },
        );
        if (!r.ok) {
          setData(EMPTY_RESP);
        } else {
          const j = (await r.json()) as SearchResp;
          setData({
            posts: j.posts ?? [],
            creators: j.creators ?? [],
          });
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          setData(EMPTY_RESP);
        }
      } finally {
        if (abortRef.current === ctrl) setLoading(false);
      }
    }, 250);

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [q, open, token]);

  // 内部跳转（关闭弹窗 + push）
  const goInternal = useCallback(
    (href: string) => {
      onClose();
      // 给 Modal 关闭动画一点时间再 push（避免 NextUI 关闭时偶发 focus 抢回）
      setTimeout(() => router.push(href), 0);
    },
    [router, onClose],
  );

  const totalCount = data.posts.length + data.creators.length;
  const trimmed = q.trim();
  const showEmptyHint = trimmed.length === 0;
  const showNoResult = !loading && trimmed.length > 0 && totalCount === 0;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      size="2xl"
      placement="top-center"
      backdrop="blur"
      hideCloseButton
      scrollBehavior="inside"
      classNames={{
        base: "mt-[10vh]",
      }}
    >
      <ModalContent>
        {() => (
          <>
            <ModalBody className="p-0">
              <div className="px-4 pt-4 pb-2">
                <Input
                  autoFocus
                  size="lg"
                  variant="flat"
                  value={q}
                  onValueChange={setQ}
                  placeholder="搜索三平台帖子、作者…  ⌘K"
                  startContent={<Search size={18} className="text-default-400" />}
                  endContent={loading ? <Spinner size="sm" /> : null}
                  classNames={{
                    input: "text-base",
                  }}
                />
              </div>

              <div className="px-2 pb-3 max-h-[60vh] overflow-y-auto">
                {showEmptyHint && (
                  <div className="px-4 py-8 text-center text-default-400 text-sm">
                    输入关键词以搜索三平台数据
                  </div>
                )}

                {showNoResult && (
                  <div className="px-4 py-8 text-center text-default-400 text-sm">
                    没有找到相关结果
                  </div>
                )}

                {!showEmptyHint && totalCount > 0 && (
                  <div className="space-y-3">
                    <ResultSection
                      icon={<FileText size={14} />}
                      label="帖子"
                      items={data.posts.slice(0, SECTION_LIMIT)}
                      total={data.posts.length}
                      renderItem={(p) => (
                        <ResultRow
                          key={`p-${p.platform}-${p.note_id}`}
                          platform={p.platform}
                          title={p.title || p.note_id}
                          subtitle={
                            <span className="text-xs text-default-400">
                              {p.liked_count > 0 && <>♥ {p.liked_count}</>}
                              {p.comment_count > 0 && (
                                <span className="ml-2">💬 {p.comment_count}</span>
                              )}
                            </span>
                          }
                          externalUrl={p.url}
                          onClick={() => goInternal(postInternalHref(p.platform, p.note_id))}
                        />
                      )}
                    />

                    <ResultSection
                      icon={<UserIcon size={14} />}
                      label="作者"
                      items={data.creators.slice(0, SECTION_LIMIT)}
                      total={data.creators.length}
                      renderItem={(c) => (
                        <ResultRow
                          key={`c-${c.platform}-${c.id}`}
                          platform={c.platform}
                          title={c.name || c.url}
                          subtitle={
                            <span className="text-xs text-default-400 truncate block">
                              {c.url}
                            </span>
                          }
                          externalUrl={c.url}
                          onClick={() => goInternal(creatorInternalHref(c.platform))}
                        />
                      )}
                    />

                  </div>
                )}
              </div>

              <div className="px-4 py-2 border-t border-divider text-xs text-default-400 flex items-center justify-between">
                <span>回车跳转 / Esc 关闭</span>
                <span className="hidden md:inline">
                  <kbd className="px-1.5 py-0.5 rounded bg-default-100 text-default-600 mr-1">⌘</kbd>
                  <kbd className="px-1.5 py-0.5 rounded bg-default-100 text-default-600">K</kbd>
                </span>
              </div>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 子组件
// ────────────────────────────────────────────────────────────────────────────

function ResultSection<T>({
  icon,
  label,
  items,
  total,
  renderItem,
}: {
  icon: React.ReactNode;
  label: string;
  items: T[];
  total: number;
  renderItem: (item: T) => React.ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-2 pt-2 pb-1 text-xs font-medium text-default-500 flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
        <span className="text-default-400">({total})</span>
      </div>
      <div>{items.map(renderItem)}</div>
    </div>
  );
}

function ResultRow({
  platform,
  title,
  subtitle,
  externalUrl,
  onClick,
}: {
  platform: string;
  title: string;
  subtitle?: React.ReactNode;
  externalUrl?: string;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="group flex items-center gap-3 px-3 py-2 rounded-md hover:bg-default-100 cursor-pointer transition-colors"
    >
      {platformChip(platform)}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate">{title}</div>
        {subtitle && <div className="truncate">{subtitle}</div>}
      </div>
      {externalUrl && (
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 text-default-400 hover:text-foreground transition-opacity p-1"
          aria-label="在新窗口打开"
        >
          <ExternalLink size={14} />
        </a>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// hook：全局 ⌘K 监听 + 状态
// ────────────────────────────────────────────────────────────────────────────

export function useGlobalSearch() {
  const [open, setOpen] = useState(false);

  const openSearch = useCallback(() => setOpen(true), []);
  const closeSearch = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K (mac) or Ctrl+K (win/linux)
      const isK = e.key === "k" || e.key === "K";
      if (isK && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((cur) => !cur);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return useMemo(
    () => ({ open, openSearch, closeSearch }),
    [open, openSearch, closeSearch],
  );
}
