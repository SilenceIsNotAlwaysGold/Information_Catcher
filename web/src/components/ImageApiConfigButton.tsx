"use client";

/**
 * 商品图 API 配置按钮（admin only）
 *
 * 把原本「监控设置 → 系统配置 → 商品图 API」的字段直接弹 modal 编辑：
 *   - base_url（OpenAI 兼容图像接口地址）
 *   - api_key（密钥，仅写不读）
 *   - model
 *   - size
 *
 * 数据走 /api/monitor/image/config（已有 GET / POST）。
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Settings as SettingsIcon, Save } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

const API = (p: string) => `/api/monitor/image${p}`;

const SIZE_OPTIONS = ["512x512", "768x768", "1024x1024", "1024x1792", "1792x1024"];

export function ImageApiConfigButton({
  hasKey,
  onSaved,
}: {
  hasKey: boolean;
  onSaved?: () => void | Promise<void>;
}) {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const modal = useDisclosure();

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("1024x1024");

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(API("/config"), { headers });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      setBaseUrl(d.base_url || "");
      setModel(d.model || "");
      setSize(d.size || "1024x1024");
      setApiKey(""); // 永远不回填，留空表示不修改
    } catch (e: any) {
      toastErr(`读取配置失败：${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (modal.isOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.isOpen]);

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {
        base_url: baseUrl.trim(),
        model: model.trim(),
        size: size.trim() || "1024x1024",
      };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      const r = await fetch(API("/config"), {
        method: "POST", headers, body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        toastErr(d.detail || `保存失败 (HTTP ${r.status})`);
        return;
      }
      toastOk("商品图 API 配置已保存");
      modal.onClose();
      if (onSaved) await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="flat"
        color={hasKey ? "default" : "warning"}
        startContent={<SettingsIcon size={15} />}
        onPress={modal.onOpen}
      >
        {hasKey ? "修改 API 配置" : "配置 API"}
      </Button>

      <Modal isOpen={modal.isOpen} onClose={modal.onClose} size="lg">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <SettingsIcon size={18} />
            商品图 API 配置（OpenAI 兼容）
          </ModalHeader>
          <ModalBody className="space-y-4">
            <p className="text-xs text-default-400">
              支持任何 OpenAI 兼容的图像生成代理（aiproxy / one-api / 自建网关均可）。
              base_url 通常以 <code>/v1</code> 结尾。
            </p>
            <Input
              label="Base URL"
              labelPlacement="outside"
              placeholder="https://aiproxy-cn.chydocx.cn/v1"
              value={baseUrl}
              onValueChange={setBaseUrl}
              isDisabled={loading}
            />
            <Input
              label="API Key"
              labelPlacement="outside"
              placeholder={hasKey ? "（已配置，留空表示不修改）" : "sk-..."}
              type="password"
              value={apiKey}
              onValueChange={setApiKey}
              isDisabled={loading}
              description={hasKey ? "如需更换 Key，输入新 Key 即可。" : "首次配置，必填。"}
            />
            <Input
              label="Model"
              labelPlacement="outside"
              placeholder="gpt-image-1 / dall-e-3 / flux-pro / ..."
              value={model}
              onValueChange={setModel}
              isDisabled={loading}
            />
            <div>
              <p className="text-sm text-default-700 mb-1.5">默认尺寸</p>
              <div className="flex flex-wrap gap-2">
                {SIZE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSize(s)}
                    disabled={loading}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${
                      size === s
                        ? "bg-primary text-white border-primary"
                        : "border-divider text-default-600 hover:bg-default-100"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={modal.onClose} isDisabled={saving}>
              取消
            </Button>
            <Button
              color="primary"
              startContent={<Save size={15} />}
              onPress={save}
              isLoading={saving}
              isDisabled={loading}
            >
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
