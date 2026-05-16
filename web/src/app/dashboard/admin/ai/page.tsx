"use client";

/**
 * /dashboard/admin/ai —— AI 模型配置（P15）
 *
 * 多 provider × 多 model 管理，按 usage_type=text|image 分 Tab 展示。
 * Admin 可：
 *   - 增删改 provider（OpenAI / DeepSeek / 硅基流动 …）
 *   - 增删改 model（挂在 provider 下）
 *   - 上下架（published）让用户能选
 *   - 设默认（每个 usage_type 一个）
 *   - 看使用记录
 */
import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Switch } from "@nextui-org/switch";
import { Tabs, Tab } from "@nextui-org/tabs";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import {
  Table, TableHeader, TableBody, TableColumn, TableRow, TableCell,
} from "@nextui-org/table";
import { Chip } from "@nextui-org/chip";
import { Tooltip } from "@nextui-org/tooltip";
import {
  Plus, Trash2, Edit3, Sparkles, AlertCircle, Star, BarChart3, RefreshCw,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import useSWR, { mutate as globalMutate } from "swr";
import { toastOk, toastErr } from "@/lib/toast";
import { PageHeader } from "@/components/ui";
import { confirmDialog } from "@/components/ConfirmDialog";

const API = (p: string) => `/api${p}`;

type Provider = {
  id: number;
  name: string;
  base_url: string;
  api_key_masked: string;
  enabled: number;
  sort_order: number;
  note: string;
  created_at?: string;
};

type Model = {
  id: number;
  provider_id: number;
  provider_name: string;
  provider_enabled: number;
  model_id: string;
  display_name: string;
  usage_type: "text" | "image";
  published: number;
  is_default: number;
  extra_config: string;
  sort_order: number;
  note: string;
  max_concurrent?: number;  // P15.8
};

const usageLabel = (u: string) => (u === "image" ? "图像" : "文本");

function useAuthHeaders() {
  const { token } = useAuth();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function fetcherWithToken([url, token]: [string, string]) {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}

export default function AdminAiPage() {
  useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";

  if (!isAdmin && me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardBody className="flex flex-row gap-2 items-center text-sm text-warning">
            <AlertCircle size={16} /> 仅管理员可访问
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-page mx-auto space-y-6">
      <PageHeader
        icon={Sparkles}
        title="AI 模型配置"
        hint="配置多个 AI 渠道 + 多个模型；上下架决定用户可见性，设默认决定未选择时用哪个；每个模型可单独设定价（price_per_call + feature_pricing）。"
      />

      <Tabs aria-label="AI Config Tabs" variant="solid" color="secondary">
        <Tab key="text" title="文本模型">
          <UsageTypePanel usageType="text" />
        </Tab>
        <Tab key="image" title="图像模型">
          <UsageTypePanel usageType="image" />
        </Tab>
        <Tab key="usage" title={<span className="flex items-center gap-1"><BarChart3 size={14} />使用记录</span>}>
          <UsagePanel />
        </Tab>
      </Tabs>
    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// 「文本模型」/「图像模型」Tab 内容：渠道表 + 模型表
// ────────────────────────────────────────────────────────────────

function UsageTypePanel({ usageType }: { usageType: "text" | "image" }) {
  const { token } = useAuth();

  const provKey = ["/api/admin/ai/providers", token] as const;
  const modKey = [`/api/admin/ai/models?usage_type=${usageType}`, token] as const;

  const { data: provData, isLoading: provLoading } =
    useSWR(provKey, fetcherWithToken);
  const { data: modData, isLoading: modLoading } =
    useSWR(modKey, fetcherWithToken);

  const providers: Provider[] = provData?.providers || [];
  const models: Model[] = modData?.models || [];

  const refreshAll = async () => {
    await globalMutate((k) =>
      Array.isArray(k) && typeof k[0] === "string" &&
      (k[0].startsWith("/api/admin/ai/providers") || k[0].startsWith("/api/admin/ai/models"))
    );
  };

  return (
    <div className="space-y-6 mt-4">
      <ProvidersCard
        providers={providers}
        loading={provLoading}
        onChanged={refreshAll}
      />
      <ModelsCard
        models={models}
        providers={providers}
        usageType={usageType}
        loading={modLoading}
        onChanged={refreshAll}
      />
    </div>
  );
}


// ────────────────────────────────────────────────────────────────
// Providers 渠道表
// ────────────────────────────────────────────────────────────────

function ProvidersCard({
  providers, loading, onChanged,
}: {
  providers: Provider[];
  loading: boolean;
  onChanged: () => Promise<any>;
}) {
  const headers = useAuthHeaders();
  const editor = useDisclosure();
  const [editing, setEditing] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [note, setNote] = useState("");

  const openNew = () => {
    setEditing(null);
    setName(""); setBaseUrl("https://api.openai.com/v1");
    setApiKey(""); setEnabled(true); setNote("");
    editor.onOpen();
  };
  const openEdit = (p: Provider) => {
    setEditing(p);
    setName(p.name); setBaseUrl(p.base_url);
    setApiKey(""); // 编辑时留空 = 不改
    setEnabled(!!p.enabled); setNote(p.note || "");
    editor.onOpen();
  };

  const save = async () => {
    const body: any = { name: name.trim(), base_url: baseUrl.trim(), enabled, note };
    if (apiKey.trim()) body.api_key = apiKey.trim();
    if (!editing) {
      if (!body.api_key) { toastErr("新建渠道必须填 API Key"); return; }
      const r = await fetch(API(`/admin/ai/providers`), {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) { toastErr("新建失败：" + (await r.text())); return; }
    } else {
      const r = await fetch(API(`/admin/ai/providers/${editing.id}`), {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      if (!r.ok) { toastErr("保存失败：" + (await r.text())); return; }
    }
    toastOk("已保存");
    editor.onClose();
    await onChanged();
  };

  const remove = async (p: Provider) => {
    const ok = await confirmDialog({
      title: "删除渠道",
      content: `删除「${p.name}」会同时删除该渠道下的所有模型，且关联用户偏好会被重置。确认？`,
      danger: true, confirmText: "删除",
    });
    if (!ok) return;
    const r = await fetch(API(`/admin/ai/providers/${p.id}`), { method: "DELETE", headers });
    if (!r.ok) { toastErr("删除失败：" + (await r.text())); return; }
    toastOk("已删除");
    await onChanged();
  };

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <span className="font-semibold">渠道（Provider）</span>
        <Button size="sm" color="primary" startContent={<Plus size={14} />} onPress={openNew}>
          新增渠道
        </Button>
      </CardHeader>
      <CardBody className="p-0">
        {loading ? (
          <div className="p-6 text-center text-default-400 text-sm">加载中…</div>
        ) : providers.length === 0 ? (
          <div className="p-6 text-center text-default-400 text-sm">
            还没有任何渠道。点右上角「新增渠道」开始。
          </div>
        ) : (
          <Table removeWrapper aria-label="Providers">
            <TableHeader>
              <TableColumn>名称</TableColumn>
              <TableColumn>Base URL</TableColumn>
              <TableColumn>API Key</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>备注</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><span className="font-medium">{p.name}</span></TableCell>
                  <TableCell><code className="text-xs">{p.base_url}</code></TableCell>
                  <TableCell><code className="text-xs text-default-500">{p.api_key_masked || "—"}</code></TableCell>
                  <TableCell>
                    {p.enabled ? (
                      <Chip size="sm" color="success" variant="flat">启用</Chip>
                    ) : (
                      <Chip size="sm" color="default" variant="flat">已禁用</Chip>
                    )}
                  </TableCell>
                  <TableCell><span className="text-xs text-default-400">{p.note || "—"}</span></TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="编辑">
                        <Button isIconOnly size="sm" variant="light" onPress={() => openEdit(p)}>
                          <Edit3 size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => remove(p)}>
                          <Trash2 size={15} />
                        </Button>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardBody>

      <Modal isOpen={editor.isOpen} onClose={editor.onClose} size="lg">
        <ModalContent>
          <ModalHeader>{editing ? "编辑渠道" : "新增渠道"}</ModalHeader>
          <ModalBody className="space-y-3">
            <Input label="渠道名称" labelPlacement="outside" placeholder="OpenAI / DeepSeek / 硅基流动"
              value={name} onValueChange={setName} />
            <Input label="Base URL" labelPlacement="outside" placeholder="https://api.openai.com/v1"
              value={baseUrl} onValueChange={setBaseUrl} />
            <Input label="API Key" labelPlacement="outside" type="password"
              placeholder={editing ? "留空 = 不修改" : "sk-..."}
              value={apiKey} onValueChange={setApiKey} />
            <Textarea label="备注（可选）" labelPlacement="outside" minRows={2}
              value={note} onValueChange={setNote} />
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm">启用该渠道（关闭后其下所有模型不可用）</span>
              <Switch isSelected={enabled} onValueChange={setEnabled} size="sm" />
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editor.onClose}>取消</Button>
            <Button color="primary" onPress={save}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}


// ────────────────────────────────────────────────────────────────
// Models 模型表（按 usage_type 过滤）
// ────────────────────────────────────────────────────────────────

function ModelsCard({
  models, providers, usageType, loading, onChanged,
}: {
  models: Model[];
  providers: Provider[];
  usageType: "text" | "image";
  loading: boolean;
  onChanged: () => Promise<any>;
}) {
  const headers = useAuthHeaders();
  const editor = useDisclosure();
  const [editing, setEditing] = useState<Model | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [published, setPublished] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [extraJson, setExtraJson] = useState("{}");
  const [note, setNote] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState<number>(0);  // P15.8

  const filtered = models.filter((m) => m.usage_type === usageType);

  const openNew = () => {
    setEditing(null);
    setProviderId(providers[0]?.id ?? null);
    setModelId(""); setDisplayName("");
    setPublished(false); setIsDefault(false);
    setExtraJson(usageType === "image" ? `{"size":"1024x1024"}` : "{}");
    setNote("");
    setMaxConcurrent(2);  // 新模型默认并发 2，避免不小心 0=不限被打爆
    editor.onOpen();
  };
  const openEdit = (m: Model) => {
    setEditing(m);
    setProviderId(m.provider_id);
    setModelId(m.model_id);
    setDisplayName(m.display_name);
    setPublished(!!m.published);
    setIsDefault(!!m.is_default);
    setExtraJson(m.extra_config || "{}");
    setNote(m.note || "");
    setMaxConcurrent(Number(m.max_concurrent || 0));
    editor.onOpen();
  };

  const save = async () => {
    if (!providerId) { toastErr("请选择渠道"); return; }
    if (!modelId.trim() || !displayName.trim()) {
      toastErr("model_id 和 display_name 必填"); return;
    }
    let extra: any;
    try {
      extra = JSON.parse(extraJson || "{}");
    } catch (e) {
      toastErr("extra_config 必须是合法 JSON"); return;
    }
    const body: any = {
      provider_id: providerId,
      model_id: modelId.trim(),
      display_name: displayName.trim(),
      usage_type: usageType,
      published, is_default: isDefault,
      extra_config: extra,
      note,
      max_concurrent: Math.max(0, Number(maxConcurrent || 0)),
    };
    if (!editing) {
      const r = await fetch(API(`/admin/ai/models`), {
        method: "POST", headers, body: JSON.stringify(body),
      });
      if (!r.ok) { toastErr("新建失败：" + (await r.text())); return; }
    } else {
      const r = await fetch(API(`/admin/ai/models/${editing.id}`), {
        method: "PUT", headers, body: JSON.stringify(body),
      });
      if (!r.ok) { toastErr("保存失败：" + (await r.text())); return; }
    }
    toastOk("已保存");
    editor.onClose();
    await onChanged();
  };

  const remove = async (m: Model) => {
    const ok = await confirmDialog({
      title: "删除模型",
      content: `确认删除模型「${m.display_name}」？所有用户偏好引用会被重置为默认。`,
      danger: true, confirmText: "删除",
    });
    if (!ok) return;
    const r = await fetch(API(`/admin/ai/models/${m.id}`), { method: "DELETE", headers });
    if (!r.ok) { toastErr("删除失败：" + (await r.text())); return; }
    toastOk("已删除");
    await onChanged();
  };

  const togglePublished = async (m: Model) => {
    await fetch(API(`/admin/ai/models/${m.id}`), {
      method: "PUT", headers,
      body: JSON.stringify({ published: !m.published }),
    });
    await onChanged();
  };

  const setAsDefault = async (m: Model) => {
    await fetch(API(`/admin/ai/models/${m.id}`), {
      method: "PUT", headers,
      body: JSON.stringify({ is_default: true }),
    });
    toastOk(`已设为默认 ${usageLabel(usageType)} 模型`);
    await onChanged();
  };

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <span className="font-semibold">{usageLabel(usageType)}模型</span>
        <Button size="sm" color="primary" startContent={<Plus size={14} />}
          onPress={openNew} isDisabled={providers.length === 0}>
          新增模型
        </Button>
      </CardHeader>
      <CardBody className="p-0">
        {loading ? (
          <div className="p-6 text-center text-default-400 text-sm">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-default-400 text-sm">
            还没有任何{usageLabel(usageType)}模型。
            {providers.length === 0 && <>先去上面「渠道」区新增一个渠道，然后回来添加模型。</>}
          </div>
        ) : (
          <Table removeWrapper aria-label="Models">
            <TableHeader>
              <TableColumn>显示名</TableColumn>
              <TableColumn>API model_id</TableColumn>
              <TableColumn>渠道</TableColumn>
              <TableColumn>上架</TableColumn>
              <TableColumn>默认</TableColumn>
              <TableColumn>并发上限</TableColumn>
              <TableColumn>额外配置</TableColumn>
              <TableColumn>操作</TableColumn>
            </TableHeader>
            <TableBody>
              {filtered.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{m.display_name}</span>
                      {m.note && <span className="text-xs text-default-400">{m.note}</span>}
                    </div>
                  </TableCell>
                  <TableCell><code className="text-xs">{m.model_id}</code></TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm">{m.provider_name}</span>
                      {!m.provider_enabled && (
                        <Chip size="sm" variant="flat" color="warning">渠道已禁</Chip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch size="sm" isSelected={!!m.published}
                      onValueChange={() => togglePublished(m)} />
                  </TableCell>
                  <TableCell>
                    {m.is_default ? (
                      <Chip size="sm" color="success" variant="flat"
                        startContent={<Star size={12} className="ml-1" />}>默认</Chip>
                    ) : (
                      <Button size="sm" variant="light" onPress={() => setAsDefault(m)}>
                        设为默认
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {Number(m.max_concurrent || 0) > 0 ? (
                      <Chip size="sm" variant="flat" color="warning">{m.max_concurrent}</Chip>
                    ) : (
                      <span className="text-xs text-default-400">不限</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs text-default-400">{m.extra_config || "{}"}</code>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Tooltip content="编辑">
                        <Button isIconOnly size="sm" variant="light" onPress={() => openEdit(m)}>
                          <Edit3 size={15} />
                        </Button>
                      </Tooltip>
                      <Tooltip content="删除" color="danger">
                        <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => remove(m)}>
                          <Trash2 size={15} />
                        </Button>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardBody>

      <Modal isOpen={editor.isOpen} onClose={editor.onClose} size="lg">
        <ModalContent>
          <ModalHeader>{editing ? "编辑模型" : `新增${usageLabel(usageType)}模型`}</ModalHeader>
          <ModalBody className="space-y-3">
            <div>
              <p className="text-xs text-default-500 mb-1">所属渠道</p>
              <select className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
                value={providerId || ""} onChange={(e) => setProviderId(Number(e.target.value))}>
                <option value="">— 选择渠道 —</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.enabled ? "" : "（已禁用）"}
                  </option>
                ))}
              </select>
            </div>
            <Input label="API model_id（调用时传给 API）" labelPlacement="outside"
              placeholder={usageType === "image" ? "gpt-image-1 / dall-e-3 / flux-pro" : "gpt-4o-mini / deepseek-chat"}
              value={modelId} onValueChange={setModelId} />
            <Input label="显示名（用户看到的）" labelPlacement="outside"
              placeholder={usageType === "image" ? "DALL·E 3 · 高清" : "GPT-4o Mini · 经济"}
              value={displayName} onValueChange={setDisplayName} />
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm">上架（用户能选）</span>
              <Switch isSelected={published} onValueChange={setPublished} size="sm" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">设为该 usage_type 的默认（未选择时用它）</span>
              <Switch isSelected={isDefault} onValueChange={setIsDefault} size="sm" />
            </div>
            <Input
              type="number" min={0} max={1000}
              label="并发上限"
              labelPlacement="outside"
              placeholder="0 = 不限"
              description="同时进行中的请求上限。超过会自动排队等待。设大数值给吞吐更高的渠道，设小数值规避平台限流。"
              value={String(maxConcurrent)}
              onValueChange={(v) => setMaxConcurrent(Math.max(0, parseInt(v || "0") || 0))}
            />
            <Textarea label="extra_config（JSON，可选）"
              labelPlacement="outside" minRows={2}
              placeholder={usageType === "image" ? '{"size":"1024x1024"}' : "{}"}
              value={extraJson} onValueChange={setExtraJson} />
            <Textarea label="备注（可选）" labelPlacement="outside" minRows={1}
              value={note} onValueChange={setNote} />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editor.onClose}>取消</Button>
            <Button color="primary" onPress={save}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}


// ────────────────────────────────────────────────────────────────
// 使用记录 Panel
// ────────────────────────────────────────────────────────────────

type UsageSummary = {
  summary: { total_calls?: number; ok_calls?: number; error_calls?: number;
    total_in?: number; total_out?: number; total_images?: number };
  by_day: { day: string; usage_type: string; calls: number;
    tokens_in: number; tokens_out: number; images: number }[];
  by_user_model: { user_id: number | null; username?: string;
    model_id_str: string; usage_type: string; calls: number;
    tokens_in: number; tokens_out: number; images: number }[];
};

function UsagePanel() {
  const { token } = useAuth();
  const [days, setDays] = useState(7);
  const { data, isLoading, mutate } =
    useSWR<UsageSummary>(
      [`/api/admin/ai/usage?days=${days}`, token] as const,
      fetcherWithToken,
    );

  const s = data?.summary || {};
  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="font-semibold">总览</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-default-500">天数：</span>
            <select className="border border-divider rounded-md px-2 h-7 text-sm bg-background"
              value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>1 天</option>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
            <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />}
              onPress={() => mutate()}>
              刷新
            </Button>
          </div>
        </CardHeader>
        <CardBody>
          {isLoading ? (
            <div className="text-default-400 text-sm">加载中…</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
              <Stat label="总调用" value={s.total_calls || 0} />
              <Stat label="成功" value={s.ok_calls || 0} color="success" />
              <Stat label="失败" value={s.error_calls || 0} color="danger" />
              <Stat label="输入 token" value={s.total_in || 0} />
              <Stat label="输出 token" value={s.total_out || 0} />
              <Stat label="生成图片" value={s.total_images || 0} />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">按用户 × 模型（Top 100）</CardHeader>
        <CardBody className="p-0">
          {!data?.by_user_model?.length ? (
            <div className="p-6 text-center text-default-400 text-sm">最近{days}天无记录</div>
          ) : (
            <Table removeWrapper aria-label="usage">
              <TableHeader>
                <TableColumn>用户</TableColumn>
                <TableColumn>模型</TableColumn>
                <TableColumn>类型</TableColumn>
                <TableColumn>调用次数</TableColumn>
                <TableColumn>输入 token</TableColumn>
                <TableColumn>输出 token</TableColumn>
                <TableColumn>图片</TableColumn>
              </TableHeader>
              <TableBody>
                {data.by_user_model.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell>{r.username || (r.user_id == null ? "系统" : r.user_id)}</TableCell>
                    <TableCell><code className="text-xs">{r.model_id_str || "—"}</code></TableCell>
                    <TableCell>
                      <Chip size="sm" variant="flat">{usageLabel(r.usage_type)}</Chip>
                    </TableCell>
                    <TableCell>{r.calls}</TableCell>
                    <TableCell>{r.tokens_in || 0}</TableCell>
                    <TableCell>{r.tokens_out || 0}</TableCell>
                    <TableCell>{r.images || 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: "success" | "danger" }) {
  const cls = color === "success" ? "text-success" : color === "danger" ? "text-danger" : "";
  return (
    <div className="flex flex-col">
      <span className="text-xs text-default-500">{label}</span>
      <span className={`text-lg font-bold ${cls}`}>{value.toLocaleString()}</span>
    </div>
  );
}
