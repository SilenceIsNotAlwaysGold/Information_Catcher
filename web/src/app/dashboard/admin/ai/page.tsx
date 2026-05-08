"use client";

/**
 * /dashboard/admin/ai —— AI 模型 admin 配置
 *
 * 全局共享（所有用户共用一组 AI Key）。改写功能、热门 prompt 生成都用这套配置。
 */
import { useState, useEffect } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Input, Textarea } from "@nextui-org/input";
import { Button } from "@nextui-org/button";
import { Switch } from "@nextui-org/switch";
import { Save, Sparkles, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { useAdminSettings } from "@/lib/useAdminSettings";

const DEFAULT_REWRITE_PROMPT =
  "你是小红书爆款文案创作者，请将以下内容改写为更吸引人的小红书风格文案，保持原意但语气更活泼、更有共鸣感，适当加入emoji。原文：\n\n{content}";

export default function AdminAiPage() {
  useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const { settings, loading, saving, saveSubset } = useAdminSettings();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [rewriteEnabled, setRewriteEnabled] = useState(false);
  const [rewritePrompt, setRewritePrompt] = useState(DEFAULT_REWRITE_PROMPT);

  useEffect(() => {
    if (!loading) {
      setBaseUrl(settings.ai_base_url || "https://api.openai.com/v1");
      setApiKey(settings.ai_api_key || "");
      setModel(settings.ai_model || "gpt-4o-mini");
      setRewriteEnabled(settings.ai_rewrite_enabled === "1" || settings.ai_rewrite_enabled === true);
      setRewritePrompt(settings.ai_rewrite_prompt || DEFAULT_REWRITE_PROMPT);
    }
  }, [loading, settings]);

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

  const handleSave = () =>
    saveSubset({
      ai_base_url: baseUrl.trim(),
      ai_api_key: apiKey.trim(),
      ai_model: model.trim() || "gpt-4o-mini",
      ai_rewrite_enabled: rewriteEnabled,
      ai_rewrite_prompt: rewritePrompt,
    }, "AI 配置已保存");

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Sparkles size={22} className="text-secondary" />
          AI 模型配置
        </h1>
        <p className="text-sm text-default-500 mt-1">
          OpenAI 兼容的 LLM 接口，用于热门帖子改写、商品图 prompt 生成等。所有用户共享同一组 Key。
        </p>
      </div>

      <Card>
        <CardHeader className="font-semibold">接口配置</CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="Base URL"
            labelPlacement="outside"
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onValueChange={setBaseUrl}
            isDisabled={loading}
          />
          <Input
            label="API Key"
            labelPlacement="outside"
            placeholder="sk-..."
            type="password"
            value={apiKey}
            onValueChange={setApiKey}
            isDisabled={loading}
          />
          <Input
            label="Model"
            labelPlacement="outside"
            placeholder="gpt-4o-mini / claude-3-5-sonnet / ..."
            value={model}
            onValueChange={setModel}
            isDisabled={loading}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold flex justify-between items-center">
          <span>自动改写（默认 prompt）</span>
          <Switch
            isSelected={rewriteEnabled}
            onValueChange={setRewriteEnabled}
            isDisabled={loading}
            size="sm"
          />
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs text-default-400">
            热门帖子 / 监控帖子触发时自动改写。如关闭，改写仅手动触发。
            <br />
            <code>{"{content}"}</code> 会被替换为原文。
          </p>
          <Textarea
            minRows={6}
            value={rewritePrompt}
            onValueChange={setRewritePrompt}
            isDisabled={loading}
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button
          color="primary"
          startContent={<Save size={16} />}
          isLoading={saving}
          onPress={handleSave}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
