"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Accordion, AccordionItem } from "@nextui-org/accordion";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toastErr } from "@/lib/toast";
import { confirmDialog } from "@/components/ConfirmDialog";

const API = (path: string) => `/api/monitor${path}`;

type Group = {
  id: number;
  name: string;
  feishu_webhook_url: string;
  wecom_webhook_url: string;
  likes_alert_enabled: number | null;
  likes_threshold: number | null;
  collects_alert_enabled: number | null;
  collects_threshold: number | null;
  comments_alert_enabled: number | null;
  comments_threshold: number | null;
  message_prefix: string;
  template_likes: string;
  template_collects: string;
  template_comments: string;
  alert_rules: string;  // JSON array
  is_builtin: number;
};

type Form = Partial<Group> & { name: string };

const EMPTY: Form = {
  name: "",
  feishu_webhook_url: "",
  wecom_webhook_url: "",
  likes_alert_enabled: null,
  likes_threshold: null,
  collects_alert_enabled: null,
  collects_threshold: null,
  comments_alert_enabled: null,
  comments_threshold: null,
  message_prefix: "",
  template_likes: "",
  template_collects: "",
  template_comments: "",
  alert_rules: "",
};

export function MonitorGroupsCard({ token }: { token: string | null }) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const [groups, setGroups] = useState<Group[]>([]);
  const editor = useDisclosure();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Form>(k: K, v: Form[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const load = async () => {
    const r = await fetch(API("/groups"), { headers });
    const d = await r.json();
    setGroups(d.groups ?? []);
  };
  useEffect(() => { if (token) load(); }, [token]);

  const openCreate = () => {
    setEditingId(null); setForm({ ...EMPTY });
    editor.onOpen();
  };
  const openEdit = (g: Group) => {
    setEditingId(g.id);
    setForm({
      ...EMPTY,
      ...g,
      // null/undefined → 留空字符串方便 Input 显示
      likes_threshold: g.likes_threshold,
      collects_threshold: g.collects_threshold,
      comments_threshold: g.comments_threshold,
    });
    editor.onOpen();
  };

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      // 把 null/空 都转成显式 null（让后端用全局值）
      const body: Record<string, any> = { name: form.name.trim() };
      const passthrough: (keyof Form)[] = [
        "message_prefix", "template_likes", "template_collects", "template_comments",
        "alert_rules",
      ];
      for (const k of passthrough) {
        body[k] = (form[k] as string) || "";
      }
      const numFields: (keyof Form)[] = [
        "likes_threshold", "collects_threshold", "comments_threshold",
      ];
      for (const k of numFields) {
        const v = form[k];
        body[k] = v === null || v === undefined || v === "" ? null : Number(v);
      }
      const boolFields: (keyof Form)[] = [
        "likes_alert_enabled", "collects_alert_enabled", "comments_alert_enabled",
      ];
      for (const k of boolFields) {
        const v = form[k];
        body[k] = v === null || v === undefined ? null : Boolean(v);
      }

      if (editingId == null) {
        // 新建：先 POST 拿 id，再 PATCH 更新所有字段
        const r = await fetch(API("/groups"), {
          method: "POST", headers,
          body: JSON.stringify({ name: body.name }),
        });
        const d = await r.json();
        if (!r.ok) {
          toastErr(d.detail || "新建失败"); return;
        }
        await fetch(API(`/groups/${d.id}`), {
          method: "PATCH", headers,
          body: JSON.stringify(body),
        });
      } else {
        await fetch(API(`/groups/${editingId}`), {
          method: "PATCH", headers,
          body: JSON.stringify(body),
        });
      }
    } finally {
      setSaving(false);
    }
    editor.onClose();
    await load();
  };

  const remove = async (g: Group) => {
    if (g.is_builtin) { toastErr("内置分组不能删除"); return; }
    const fallback = groups.find((x) => x.is_builtin);
    const ok = await confirmDialog({
      title: "删除分组",
      content: `删除分组「${g.name}」？该分组下的帖子会迁到「${fallback?.name ?? "无分组"}」`,
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    const url = fallback ? API(`/groups/${g.id}?fallback=${fallback.id}`) : API(`/groups/${g.id}`);
    await fetch(url, { method: "DELETE", headers });
    await load();
  };

  return (
    <>
      <Card>
        <CardHeader className="flex justify-between items-center">
          <div>
            <span className="font-semibold">监控分组</span>
            <p className="text-xs text-default-400 mt-1">
              不同分组可独立配置 webhook、阈值和消息模板。模板支持变量
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;title&#125;</code>
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;liked_delta&#125;</code>
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;liked_count&#125;</code>
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;collected_delta&#125;</code>
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;comment_delta&#125;</code>
              <code className="bg-default-100 px-1 mx-1 rounded">&#123;note_url&#125;</code>
            </p>
          </div>
          <Button size="sm" color="primary" variant="flat"
            startContent={<Plus size={14} />} onPress={openCreate}>
            新建分组
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {groups.length === 0 ? (
            <p className="p-4 text-sm text-default-400">暂无分组</p>
          ) : (
            <Table aria-label="groups" removeWrapper>
              <TableHeader>
                <TableColumn>名称</TableColumn>
                <TableColumn>独立配置</TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{g.name}</span>
                        {g.is_builtin ? (
                          <Chip size="sm" color="default" variant="flat">内置</Chip>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 text-xs">
                        {(g.likes_threshold || g.collects_threshold || g.comments_threshold) && (
                          <Chip size="sm" color="warning" variant="flat">自定义阈值</Chip>
                        )}
                        {(g.template_likes || g.template_collects || g.template_comments) && (
                          <Chip size="sm" color="secondary" variant="flat">自定义模板</Chip>
                        )}
                        {g.message_prefix && <Chip size="sm" color="default" variant="flat">前缀: {g.message_prefix}</Chip>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button isIconOnly size="sm" variant="light"
                          onPress={() => openEdit(g)}><Pencil size={15} /></Button>
                        {!g.is_builtin && (
                          <Button isIconOnly size="sm" variant="light" color="danger"
                            onPress={() => remove(g)}><Trash2 size={15} /></Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal isOpen={editor.isOpen} onClose={editor.onClose} size="3xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{editingId == null ? "新建分组" : "编辑分组"}</ModalHeader>
          <ModalBody className="space-y-4">
            <Input
              label="分组名称"
              placeholder="例：竞品 A / 美妆类"
              value={form.name}
              onValueChange={(v) => set("name", v)}
            />
            <Input
              label="消息前缀"
              placeholder="例：【竞品 A 监控】"
              description="加在所有推送消息开头"
              value={form.message_prefix || ""}
              onValueChange={(v) => set("message_prefix", v)}
            />

            <Accordion variant="bordered">
              <AccordionItem key="thresholds" title="独立告警阈值（留空 = 用全局）" classNames={{ title: "text-sm" }}>
                <div className="space-y-3 pt-2">
                  {[
                    { key: "likes" as const,    label: "点赞" },
                    { key: "collects" as const, label: "收藏" },
                    { key: "comments" as const, label: "评论" },
                  ].map((r) => {
                    const enableKey = `${r.key}_alert_enabled` as keyof Form;
                    const thrKey = `${r.key}_threshold` as keyof Form;
                    return (
                      <div key={r.key} className="flex items-center gap-3">
                        <span className="text-sm w-12">{r.label}</span>
                        <Switch
                          size="sm"
                          isSelected={!!form[enableKey]}
                          onValueChange={(v) => set(enableKey, v as any)}
                        >
                          <span className="text-xs">启用</span>
                        </Switch>
                        <Input
                          size="sm" type="number"
                          placeholder="阈值"
                          value={form[thrKey] === null || form[thrKey] === undefined ? "" : String(form[thrKey])}
                          onValueChange={(v) => set(thrKey, (v === "" ? null : Number(v)) as any)}
                        />
                      </div>
                    );
                  })}
                </div>
              </AccordionItem>

              <AccordionItem key="templates" title="自定义消息模板（留空 = 用默认）" classNames={{ title: "text-sm" }}>
                <div className="space-y-3 pt-2">
                  <Textarea label="点赞告警模板"
                    placeholder="「{title}」点赞 **+{liked_delta}**（当前 {liked_count}）"
                    value={form.template_likes || ""}
                    onValueChange={(v) => set("template_likes", v)}
                    minRows={2} />
                  <Textarea label="收藏告警模板"
                    placeholder="「{title}」收藏 **+{collected_delta}**（当前 {collected_count}）"
                    value={form.template_collects || ""}
                    onValueChange={(v) => set("template_collects", v)}
                    minRows={2} />
                  <Textarea label="评论告警模板"
                    placeholder="「{title}」新增评论 **{comment_delta}** 条"
                    value={form.template_comments || ""}
                    onValueChange={(v) => set("template_comments", v)}
                    minRows={2} />
                </div>
              </AccordionItem>

              <AccordionItem key="rules" title="高级告警规则（JSON，留空 = 用上面阈值）" classNames={{ title: "text-sm" }}>
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-default-500">
                    支持的规则类型：
                  </p>
                  <ul className="text-xs text-default-500 ml-3 space-y-0.5">
                    <li>· <code>delta</code>：单次涨幅 ≥ threshold（同上面阈值）</li>
                    <li>· <code>cumulative</code>：累计 ≥ threshold 时<b>首次</b>通知一次（不重复）</li>
                    <li>· <code>percent</code>：window_hours 内涨幅 ≥ threshold_pct%</li>
                  </ul>
                  <p className="text-xs text-default-500 mt-2">所有规则都自带 4h 去抖动（同帖子同指标 4h 内不重复）。</p>
                  <Textarea
                    label="alert_rules JSON"
                    placeholder={`[
  {"type": "delta",      "metric": "liked",     "threshold": 100},
  {"type": "cumulative", "metric": "liked",     "threshold": 10000},
  {"type": "percent",    "metric": "comment",   "threshold_pct": 50, "window_hours": 24}
]`}
                    value={form.alert_rules || ""}
                    onValueChange={(v) => set("alert_rules", v)}
                    minRows={6} className="font-mono text-xs"
                  />
                </div>
              </AccordionItem>
            </Accordion>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editor.onClose}>取消</Button>
            <Button color="primary" isLoading={saving} onPress={save}
              isDisabled={!form.name.trim()}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
