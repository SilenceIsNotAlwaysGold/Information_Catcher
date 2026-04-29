"use client";

import { Card, CardBody, Chip } from "@nextui-org/react";
import { Construction } from "lucide-react";

export function PlatformPlaceholder({
  name, intro, capabilities,
}: {
  name: string;
  intro: string;
  capabilities: { label: string; status: "planned" | "wip" | "done" }[];
}) {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold">{name}</h1>
        <Chip size="sm" color="warning" variant="flat" startContent={<Construction size={12} />}>
          开发中
        </Chip>
      </div>
      <p className="text-sm text-default-500">{intro}</p>

      <Card>
        <CardBody className="space-y-3">
          <p className="text-sm font-medium">规划中的能力</p>
          <ul className="space-y-2">
            {capabilities.map((c, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <Chip
                  size="sm" variant="flat"
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

      <p className="text-xs text-default-400">
        进度跟踪可关注 GitHub issue 列表。有具体诉求请反馈。
      </p>
    </div>
  );
}
