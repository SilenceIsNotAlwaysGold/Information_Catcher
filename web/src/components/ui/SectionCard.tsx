"use client";

/**
 * SectionCard — 内容卡片统一外壳。
 *
 * 替代我们到处散用的 <Card><CardHeader>title</CardHeader><CardBody>...</CardBody></Card>，
 * 让每个卡片的标题、副标题、操作按钮排版完全一致。
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ [icon] 标题                              [右上 actions]         │
 *   │        可选副标题                                                │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ children                                                          │
 *   └──────────────────────────────────────────────────────────────────┘
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";

type Props = {
  title?: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  /** 标题旁边小标签（Chip） */
  badge?: ReactNode;
  /** 右上角操作按钮组 */
  actions?: ReactNode;
  /** 卡片内容 */
  children: ReactNode;
  /** 透传到外层 div */
  className?: string;
  /** 内容区 padding 控制：normal（默认）/ none（用于自带表格的全幅卡） */
  bodyPad?: "normal" | "none";
};

export function SectionCard({
  title, hint, icon: Icon, badge, actions, children,
  className = "", bodyPad = "normal",
}: Props) {
  return (
    <Card
      className={`shadow-card hover:shadow-card-hover transition-shadow border border-default-200/60 bg-content1 ${className}`}
      shadow="none"
    >
      {(title || actions) && (
        <CardHeader className="flex items-start justify-between gap-3 pb-2">
          <div className="flex items-start gap-2 min-w-0">
            {Icon && <Icon size={16} className="text-default-500 mt-1 shrink-0" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {title && <span className="font-semibold text-foreground">{title}</span>}
                {badge}
              </div>
              {hint && <p className="text-xs text-default-500 mt-0.5">{hint}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </CardHeader>
      )}
      <CardBody className={bodyPad === "none" ? "p-0" : "pt-2"}>{children}</CardBody>
    </Card>
  );
}
