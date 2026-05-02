"use client";

import { Card, CardBody } from "@nextui-org/card";
import { Chip } from "@nextui-org/chip";
import { Construction } from "lucide-react";

type Capability = { label: string; status: "planned" | "wip" | "done" };

/**
 * 通用「开发中」占位组件。支持两种用法：
 *   1. <PlatformPlaceholder feature="xxx" issue="123" />     —— 简化：只显示功能名 + 链接
 *   2. <PlatformPlaceholder name="xxx" intro="..." capabilities=[...] /> —— 完整：含能力列表
 */
export function PlatformPlaceholder(props: {
  name?: string;
  intro?: string;
  capabilities?: Capability[];
  feature?: string;
  issue?: string;
}) {
  const { name, intro, capabilities, feature, issue } = props;

  // 简化模式：只给了 feature
  if (feature !== undefined && !name) {
    const issueUrl = issue ? `https://github.com/issues?q=${encodeURIComponent(issue)}` : "";
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{feature}</h2>
          <Chip size="sm" color="warning" variant="dot" startContent={<Construction size={12} />}>
            开发中
          </Chip>
        </div>
        <Card shadow="sm" className="rounded-xl">
          <CardBody>
            <p className="text-sm text-default-500">
              该功能尚未在前端集成。
              {issue && (
                <>
                  {" "}
                  跟踪 issue：{" "}
                  <a className="text-primary hover:underline" href={issueUrl} target="_blank" rel="noreferrer">
                    {issue}
                  </a>
                </>
              )}
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
        <Chip size="sm" color="warning" variant="dot" startContent={<Construction size={12} />}>
          开发中
        </Chip>
      </div>
      {intro && <p className="text-[13px] text-default-500">{intro}</p>}

      {capabilities && capabilities.length > 0 && (
        <Card shadow="sm" className="rounded-xl">
          <CardBody className="space-y-3">
            <p className="text-sm font-medium">规划中的能力</p>
            <ul className="space-y-2">
              {capabilities.map((c, i) => (
                <li key={i} className="flex items-center gap-3 text-[13px]">
                  <Chip
                    size="sm" variant="dot"
                    color={c.status === "done" ? "success" : c.status === "wip" ? "warning" : "default"}
                  >
                    {c.status === "done" ? "已实现" : c.status === "wip" ? "开发中" : "规划"}
                  </Chip>
                  <span>{c.label}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <p className="text-xs text-default-400">
        进度跟踪可关注 GitHub issue 列表。有具体诉求请反馈。
      </p>
    </div>
  );
}
