// 商品图 / 仿写共用工具

export const IMAGE_API = (path: string) => `/api/monitor/image${path}`;

// 把七牛 / 本地存储 URL 包成代理 URL，避免 HTTPS 页面下 mixed content 拦截
export const proxyUrl = (raw: string | undefined | null): string => {
  if (!raw) return "";
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return raw;
  return `/api/monitor/image/proxy?url=${encodeURIComponent(raw)}`;
};

export type ImageConfig = {
  base_url: string;
  model: string;
  size: string;
  has_key: boolean;
};

export const DEFAULT_IMAGE_CONFIG: ImageConfig = {
  base_url: "", model: "", size: "1024x1024", has_key: false,
};

export const SIZE_OPTIONS = [
  { key: "864x1152",  label: "小红书 3:4（864 × 1152）" },
  { key: "720x1280",  label: "抖音 9:16（720 × 1280）" },
  { key: "1024x1024", label: "正方形 1:1（1024 × 1024）" },
  { key: "512x512",   label: "正方形 1:1 小图（512 × 512，快）" },
  { key: "768x768",   label: "正方形 1:1（768 × 768）" },
  { key: "1024x1792", label: "竖图 9:16 高清（1024 × 1792）" },
  { key: "1792x1024", label: "横图 16:9（1792 × 1024）" },
];
