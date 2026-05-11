"use client";

/**
 * 我的 AI 模型：让用户自带 OpenAI 兼容的 LLM / 图像生成模型。
 *
 * 一行 = 一个模型（后端自动配一条专属 provider）。文本 / 图像分两块展示。
 * 添加后会立刻出现在所有 ModelSelector 下拉里（OCR、整体仿写、文案换背景…）。
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, useDisclosure,
} from "@nextui-org/modal";
import { Cpu, Plus, Edit, Trash2, FlaskConical, Eye, EyeOff } from "lucide-react";
import { toastOk, toastErr } from "@/lib/toast";
import { mutateAiModels } from "@/lib/useApi";
import { confirmDialog } from "@/components/ConfirmDialog";

type MyModel = {
  id: number;
  display_name: string;
  usage_type: "text" | "image";
  model_id: string;
  base_url: string;
  api_key_masked: string;
  extra_config: Record<string, any>;
  max_concurrent: number;
  created_at: string;
};

interface Props { token: string | null; }

export function MyAiModelsCard({ token }: Props) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token || ""}`,
  };
  const [models, setModels] = useState<MyModel[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/ai/my-models", { headers });
      const d = await r.json().catch(() => ({}));
      if (Array.isArray(d.models)) setModels(d.models);
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // 编辑 / 新建 modal
  const { isOpen, onOpen, onOpenChange, onClose } = useDisclosure();
  const [editing, setEditing] = useState<MyModel | null>(null);
  const [form, setForm] = useState({
    display_name: "",
    usage_type: "text" as "text" | "image",
    base_url: "",
    api_key: "",
    model_id: "",
    image_size: "",     // 仅 usage=image 用，落到 extra_config.size
    max_concurrent: 2,
  });
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm({
      display_name: "", usage_type: "text",
      base_url: "https://api.openai.com/v1",
      api_key: "", model_id: "", image_size: "", max_concurrent: 2,
    });
    setShowKey(false);
    onOpen();
  };
  const openEdit = (m: MyModel) => {
    setEditing(m);
    setForm({
      display_name: m.display_name,
      usage_type: m.usage_type,
      base_url: m.base_url,
      api_key: "",  // 编辑时空 = 保留原值
      model_id: m.model_id,
      image_size: String((m.extra_config && m.extra_config.size) || ""),
      max_concurrent: m.max_concurrent || 2,
    });
    setShowKey(false);
    onOpen();
  };

  const submit = async () => {
    if (!form.display_name.trim() || !form.base_url.trim()
        || !form.model_id.trim()) {
      toastErr("请填写名称 / Base URL / 模型 ID");
      return;
    }
    if (!editing && !form.api_key.trim()) {
      toastErr("请填写 API Key");
      return;
    }
    setSaving(true);
    try {
      const extra: Record<string, any> = {};
      if (form.usage_type === "image" && form.image_size.trim()) {
        extra.size = form.image_size.trim();
      }
      const payload: any = {
        display_name: form.display_name.trim(),
        base_url: form.base_url.trim(),
        model_id: form.model_id.trim(),
        max_concurrent: form.max_concurrent,
        extra_config: extra,
      };
      if (!editing) {
        payload.usage_type = form.usage_type;
        payload.api_key = form.api_key.trim();
      } else if (form.api_key.trim()) {
        // 编辑时只传非空 api_key
        payload.api_key = form.api_key.trim();
      }
      const url = editing
        ? `/api/ai/my-models/${editing.id}`
        : "/api/ai/my-models";
      const method = editing ? "PUT" : "POST";
      const r = await fetch(url, { method, headers, body: JSON.stringify(payload) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        toastErr(`保存失败：${d?.detail || `HTTP ${r.status}`}`);
        return;
      }
      toastOk(editing ? "已更新" : "已新增");
      onClose();
      await load();
      await mutateAiModels();
    } catch (e: any) {
      toastErr(`保存异常：${e?.message || e}`);
    } finally { setSaving(false); }
  };

  const remove = async (m: MyModel) => {
    const ok = await confirmDialog({
      title: "删除模型",
      content: `删除「${m.display_name}」？已用过这个模型的历史记录不受影响。`,
      confirmText: "删除", cancelText: "取消", danger: true,
    });
    if (!ok) return;
    const r = await fetch(`/api/ai/my-models/${m.id}`, { method: "DELETE", headers });
    if (r.ok) {
      toastOk("已删除");
      await load();
      await mutateAiModels();
    } else {
      const d = await r.json().catch(() => ({}));
      toastErr(`删除失败：${d?.detail || `HTTP ${r.status}`}`);
    }
  };

  const test = async (m: MyModel) => {
    setTestingId(m.id);
    try {
      const r = await fetch(`/api/ai/my-models/${m.id}/test`, {
        method: "POST", headers,
      });
      const d = await r.json().catch(() => ({}));
      if (d?.ok) {
        toastOk(`连通正常（HTTP ${d.status}）`);
      } else {
        toastErr(`测试失败：${d?.error || `HTTP ${d?.status} ${(d?.body || "").slice(0, 80)}`}`);
      }
    } finally { setTestingId(null); }
  };

  const textModels = models.filter((m) => m.usage_type === "text");
  const imageModels = models.filter((m) => m.usage_type === "image");

  const renderRow = (m: MyModel) => (
    <div key={m.id}
      className="flex items-center justify-between gap-2 p-2 rounded-md border border-default-200 hover:bg-default-50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{m.display_name}</span>
          <Chip size="sm" variant="flat" color={m.usage_type === "text" ? "primary" : "secondary"}>
            {m.usage_type === "text" ? "文本" : "图像"}
          </Chip>
          <span className="text-xs text-default-500 truncate">{m.model_id}</span>
        </div>
        <div className="text-[11px] text-default-400 truncate">
          {m.base_url} · key {m.api_key_masked}
          {m.extra_config?.size ? ` · size ${m.extra_config.size}` : ""}
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        <Button size="sm" variant="flat" isIconOnly title="测试连通"
          isLoading={testingId === m.id}
          startContent={testingId === m.id ? undefined : <FlaskConical size={14} />}
          onPress={() => test(m)} />
        <Button size="sm" variant="flat" isIconOnly title="编辑"
          startContent={<Edit size={14} />} onPress={() => openEdit(m)} />
        <Button size="sm" variant="flat" color="danger" isIconOnly title="删除"
          startContent={<Trash2 size={14} />} onPress={() => remove(m)} />
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader className="flex justify-between items-center w-full">
        <div className="flex items-center gap-2">
          <Cpu size={16} />
          <span className="font-semibold">我的 AI 模型</span>
          <Chip size="sm" variant="flat">{models.length}</Chip>
        </div>
        <Button size="sm" color="primary" variant="flat"
          startContent={<Plus size={14} />}
          onPress={openCreate}>添加</Button>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-xs text-default-500">
          自带 OpenAI 兼容的 LLM / 图像生成模型（DeepSeek、Qwen、本地 vLLM、第三方代理都行）。
          添加后会出现在 OCR / 仿写 / 文案换背景的模型下拉里。
        </p>
        {loading && <p className="text-sm text-default-400">加载中…</p>}
        {!loading && models.length === 0 && (
          <div className="text-center py-6 text-default-400 text-sm">
            还没添加过模型。点右上「添加」开始。
          </div>
        )}
        {textModels.length > 0 && (
          <div>
            <p className="text-xs text-default-600 mb-1">文本模型</p>
            <div className="space-y-1">{textModels.map(renderRow)}</div>
          </div>
        )}
        {imageModels.length > 0 && (
          <div>
            <p className="text-xs text-default-600 mb-1">图像模型</p>
            <div className="space-y-1">{imageModels.map(renderRow)}</div>
          </div>
        )}
      </CardBody>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg">
        <ModalContent>
          {() => (
            <>
              <ModalHeader>{editing ? `编辑「${editing.display_name}」` : "添加 AI 模型"}</ModalHeader>
              <ModalBody className="space-y-3">
                <Input size="sm" label="显示名称" labelPlacement="outside"
                  placeholder="例：我的 GPT-4o"
                  value={form.display_name}
                  onValueChange={(v) => setForm((f) => ({ ...f, display_name: v }))} />
                {!editing && (
                  <div>
                    <p className="text-xs text-default-600 mb-1">用途</p>
                    <div className="flex gap-2">
                      {(["text", "image"] as const).map((u) => (
                        <button key={u} type="button"
                          onClick={() => setForm((f) => ({ ...f, usage_type: u }))}
                          className={`px-3 py-1.5 text-xs rounded border transition ${
                            form.usage_type === u
                              ? "border-secondary bg-secondary/10 text-secondary font-medium"
                              : "border-divider text-default-500 hover:border-secondary/50"
                          }`}>
                          {u === "text" ? "文本（chat/completions）" : "图像（images/edits）"}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <Input size="sm" label="Base URL" labelPlacement="outside"
                  placeholder="https://api.openai.com/v1（不要带末尾 /chat/completions）"
                  value={form.base_url}
                  onValueChange={(v) => setForm((f) => ({ ...f, base_url: v }))} />
                <Input size="sm" label="模型 ID（API 调用时传的 model 字段）"
                  labelPlacement="outside"
                  placeholder="例：gpt-4o-mini / qwen-vl-plus / deepseek-chat"
                  value={form.model_id}
                  onValueChange={(v) => setForm((f) => ({ ...f, model_id: v }))} />
                <Input size="sm" type={showKey ? "text" : "password"}
                  label={editing ? "API Key（留空保留原值）" : "API Key"}
                  labelPlacement="outside"
                  placeholder={editing ? "•••••（不改保留原 key）" : "sk-..."}
                  value={form.api_key}
                  onValueChange={(v) => setForm((f) => ({ ...f, api_key: v }))}
                  endContent={
                    <button type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="text-default-400">
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  } />
                {form.usage_type === "image" && (
                  <Input size="sm" label="图像尺寸（可选，覆盖默认）"
                    labelPlacement="outside"
                    placeholder="例：1024x1024 / 1024x1536"
                    value={form.image_size}
                    onValueChange={(v) => setForm((f) => ({ ...f, image_size: v }))} />
                )}
                <Input size="sm" type="number" min={0} max={20}
                  label="最大并发（0 = 不限）" labelPlacement="outside"
                  value={String(form.max_concurrent)}
                  onValueChange={(v) => {
                    const n = parseInt(v, 10);
                    setForm((f) => ({ ...f, max_concurrent: isNaN(n) ? 2 : Math.max(0, Math.min(20, n)) }));
                  }} />
              </ModalBody>
              <ModalFooter>
                <Button variant="flat" onPress={onClose}>取消</Button>
                <Button color="primary" isLoading={saving} onPress={submit}>
                  {editing ? "保存" : "创建"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </Card>
  );
}
