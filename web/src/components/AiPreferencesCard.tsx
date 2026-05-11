"use client";

/**
 * P15: 用户级 AI 模型偏好卡片。
 *
 * 在个人设置页让用户设置自己默认用哪个文本 / 图像模型。
 * 设了之后，所有改写 / 生图 modal 的「选择模型」下拉默认值就用这个。
 */
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { useAiModels, mutateAiModels, mutateMe } from "@/lib/useApi";
import { useState } from "react";
import { Save, Sparkles } from "lucide-react";
import { toastOk, toastErr } from "@/lib/toast";

interface Props { token: string | null; }

export function AiPreferencesCard({ token }: Props) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token || ""}` };
  const { models: textModels, preferred: prefText, isLoading: loadText } = useAiModels("text");
  const { models: imageModels, preferred: prefImage, isLoading: loadImage } = useAiModels("image");

  const [textSel, setTextSel] = useState<number | null | "init">("init");
  const [imageSel, setImageSel] = useState<number | null | "init">("init");
  const [saving, setSaving] = useState(false);

  // 用 "init" 标记还没初始化过，加载完后用偏好初始化（只一次）
  const actualText = textSel === "init" ? prefText : textSel;
  const actualImage = imageSel === "init" ? prefImage : imageSel;

  const onSave = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/ai/preferences", {
        method: "PUT", headers,
        body: JSON.stringify({
          preferred_text_model_id: actualText,
          preferred_image_model_id: actualImage,
        }),
      });
      if (!r.ok) {
        toastErr("保存失败：" + (await r.text()));
        return;
      }
      toastOk("AI 偏好已保存");
      await mutateAiModels();
      await mutateMe();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="font-semibold flex items-center gap-2">
        <Sparkles size={16} className="text-secondary" />
        我的 AI 模型偏好
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-default-500">
          设置后，所有改写 / 生图功能里的「选择模型」下拉会默认用你选的模型。
          没设置或选择「使用系统默认」时，用管理员设定的默认模型。
        </p>

        <div>
          <p className="text-sm font-medium mb-1">文本模型（用于改写 / Prompt 生成）</p>
          <select className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
            value={actualText ?? ""}
            onChange={(e) => setTextSel(e.target.value ? Number(e.target.value) : null)}
            disabled={loadText}>
            <option value="">使用系统默认</option>
            {textModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name} · {m.provider_name}
                {m.is_default ? "  [系统默认]" : ""}
              </option>
            ))}
          </select>
          {!loadText && textModels.length === 0 && (
            <p className="text-xs text-default-400 mt-1">管理员还没上架任何文本模型。</p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium mb-1">图像模型（用于商品图 / 仿写生图）</p>
          <select className="border border-divider rounded-md px-2 h-9 text-sm bg-background w-full"
            value={actualImage ?? ""}
            onChange={(e) => setImageSel(e.target.value ? Number(e.target.value) : null)}
            disabled={loadImage}>
            <option value="">使用系统默认</option>
            {imageModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name} · {m.provider_name}
                {m.is_default ? "  [系统默认]" : ""}
              </option>
            ))}
          </select>
          {!loadImage && imageModels.length === 0 && (
            <p className="text-xs text-default-400 mt-1">管理员还没上架任何图像模型。</p>
          )}
        </div>

        <div className="flex justify-end">
          <Button color="primary" size="sm" startContent={<Save size={14} />}
            isLoading={saving} onPress={onSave}>
            保存偏好
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
