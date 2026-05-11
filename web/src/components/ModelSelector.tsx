"use client";

/**
 * 模型选择器 —— 改写 / 生图 / 仿写 modal 里复用的下拉。
 *
 * - value=null 表示「使用系统/我的默认」
 * - 列表是 admin 在 /dashboard/admin/ai 上架的模型（仅 published）
 * - 自动按用户偏好高亮（display 后面带「★ 我的偏好」）
 */
import { useAiModels, AiModelOption } from "@/lib/useApi";

interface Props {
  usage: "text" | "image";
  value: number | null;
  onChange: (id: number | null) => void;
  label?: string;
  className?: string;
}

export function ModelSelector({ usage, value, onChange, label, className }: Props) {
  const { models, preferred, isLoading } = useAiModels(usage);

  const showLabel = label ?? (usage === "image" ? "图像模型" : "AI 模型");

  return (
    <div className={className}>
      <p className="text-xs text-default-500 mb-1">{showLabel}</p>
      <select
        className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        disabled={isLoading}
      >
        <option value="">
          {preferred
            ? "使用我的默认偏好"
            : "使用系统默认"}
        </option>
        {models.map((m: AiModelOption) => {
          const tags: string[] = [];
          if (m.id === preferred) tags.push("★ 我的偏好");
          if (m.is_default) tags.push("系统默认");
          return (
            <option key={m.id} value={m.id}>
              {m.display_name} · {m.provider_name}
              {tags.length ? `  [${tags.join(" / ")}]` : ""}
            </option>
          );
        })}
      </select>
      {!isLoading && models.length === 0 && (
        <p className="text-xs text-default-400 mt-1">
          管理员还没上架任何{usage === "image" ? "图像" : "文本"}模型，将使用系统默认。
        </p>
      )}
    </div>
  );
}
