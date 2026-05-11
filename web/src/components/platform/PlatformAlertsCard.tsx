"use client";

import { useState } from "react";
import {
  Card, CardHeader, CardBody, Button, Chip, Tooltip,
  Table, TableHeader, TableBody, TableColumn, TableRow, TableCell,
} from "@nextui-org/react";
import { Trash2, ChevronUp, ChevronDown } from "lucide-react";
import { useAlerts, mutateAlerts } from "@/lib/useApi";
import { confirmDialog } from "@/components/ConfirmDialog";

const API = (path: string) => `/api/monitor${path}`;

const alertTypeColor = (t: string): "warning" | "primary" | "success" =>
  t === "likes" || t === "collects" ? "warning" : "primary";

const alertTypeLabel = (t: string) => {
  if (t === "likes") return "点赞飙升";
  if (t === "collects") return "收藏飙升";
  if (t === "comment") return "新评论";
  if (t.endsWith("_delta")) return t.replace("_delta", " 增量");
  if (t.includes("_cum_")) return "累计达标";
  if (t.endsWith("_pct")) return "涨幅告警";
  return t;
};

interface Props {
  platform: "xhs" | "douyin" | "mp";
  headers: HeadersInit;
}

/**
 * 按平台展示告警记录卡片。每个平台 (xhs/douyin/mp) 各自只看自己的告警，
 * 不互相污染。卡片默认折叠，点击展开。
 */
export default function PlatformAlertsCard({ platform, headers }: Props) {
  const { alerts } = useAlerts(30, platform);
  const [open, setOpen] = useState(false);

  if (!alerts.length) return null;

  const handleDelete = async (id: number) => {
    await fetch(API(`/alerts/${id}`), { method: "DELETE", headers });
    await mutateAlerts();
  };

  const handleClear = async () => {
    const ok = await confirmDialog({
      title: "清空告警记录",
      content: `确认清空全部 ${alerts.length} 条告警记录？`,
      confirmText: "清空",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    await fetch(API(`/alerts?platform=${platform}`), { method: "DELETE", headers });
    await mutateAlerts();
  };

  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardHeader
        className="flex justify-between items-center py-2 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 text-warning-700">
          <span className="text-base">⚠️</span>
          <span className="text-sm font-medium">
            告警记录（{alerts.length} 条未处理）
          </span>
          <span className="text-xs text-default-500">
            {open ? "点击折叠" : "点击展开"}
          </span>
        </div>
        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="flat" color="danger"
            startContent={<Trash2 size={14} />}
            onPress={handleClear}>
            清空
          </Button>
          <Button size="sm" variant="light" isIconOnly
            onPress={() => setOpen((v) => !v)}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardBody className="p-0 border-t border-divider">
          <Table aria-label="alerts" removeWrapper>
            <TableHeader>
              <TableColumn>类型</TableColumn>
              <TableColumn>帖子</TableColumn>
              <TableColumn>消息</TableColumn>
              <TableColumn>时间</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {alerts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Chip size="sm" color={alertTypeColor(a.alert_type)} variant="flat">
                      {alertTypeLabel(a.alert_type)}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm truncate max-w-xs block">
                      {a.title || a.note_id}
                    </span>
                  </TableCell>
                  <TableCell><span className="text-sm">{a.message}</span></TableCell>
                  <TableCell>
                    <span className="text-xs text-default-400">{a.created_at?.slice(0, 16)}</span>
                  </TableCell>
                  <TableCell>
                    <Tooltip content="删除" color="danger">
                      <Button isIconOnly size="sm" variant="light" color="danger"
                        onPress={() => handleDelete(a.id)}>
                        <Trash2 size={15} />
                      </Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      )}
    </Card>
  );
}
