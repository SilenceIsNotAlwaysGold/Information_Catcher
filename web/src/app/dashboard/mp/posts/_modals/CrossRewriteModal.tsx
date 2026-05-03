"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Tooltip } from "@nextui-org/tooltip";
import { Wand2, Copy } from "lucide-react";

export type CrossMode = "xhs" | "douyin" | "mp" | "saved" | "custom";
export type SavedPrompt = { id: number; name: string; content: string; is_default?: number };

export type CrossRewriteModalProps = {
  isOpen: boolean;
  onClose: () => void;
  crossMode: CrossMode;
  setCrossMode: (m: CrossMode) => void;
  crossPromptId: string;
  setCrossPromptId: (v: string) => void;
  crossPromptText: string;
  setCrossPromptText: (v: string) => void;
  crossVariantCount: number;
  setCrossVariantCount: (n: number) => void;
  savedPrompts: SavedPrompt[];
  promptsLoading: boolean;
  crossError: string;
  crossLoading: boolean;
  crossVariants: string[];
  onRun: () => void;
};

export default function CrossRewriteModal({
  isOpen, onClose, crossMode, setCrossMode,
  crossPromptId, setCrossPromptId, crossPromptText, setCrossPromptText,
  crossVariantCount, setCrossVariantCount,
  savedPrompts, promptsLoading,
  crossError, crossLoading, crossVariants, onRun,
}: CrossRewriteModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Wand2 size={18} className="text-primary" />
          AI 改写
          <Chip size="sm" variant="flat">{crossVariantCount} 个变体</Chip>
        </ModalHeader>
        <ModalBody className="space-y-3">
          {/* 目标平台 / 模式选择 */}
          <div>
            <p className="text-xs text-default-500 mb-2">目标平台 / 改写风格</p>
            <div className="flex flex-wrap gap-2">
              {([
                { key: "xhs",    label: "小红书" },
                { key: "douyin", label: "抖音" },
                { key: "mp",     label: "公众号" },
                { key: "saved",  label: "我的 Prompt" },
                { key: "custom", label: "自定义" },
              ] as { key: CrossMode; label: string }[]).map((opt) => (
                <Chip key={opt.key}
                  size="sm"
                  variant={crossMode === opt.key ? "solid" : "flat"}
                  color={crossMode === opt.key ? "primary" : "default"}
                  className="cursor-pointer"
                  onClick={() => setCrossMode(opt.key)}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
          </div>

          {/* saved 模式：选择已保存 prompt */}
          {crossMode === "saved" && (
            <div>
              <Select
                size="sm"
                label="选择保存的 Prompt"
                placeholder={promptsLoading ? "加载中…" : "—"}
                selectedKeys={crossPromptId ? [crossPromptId] : []}
                onSelectionChange={(keys) => {
                  const v = Array.from(keys)[0];
                  setCrossPromptId(v ? String(v) : "");
                }}
              >
                {savedPrompts.map((p) => (
                  <SelectItem key={String(p.id)} textValue={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </Select>
              {savedPrompts.length === 0 && !promptsLoading && (
                <p className="text-xs text-default-400 mt-1">
                  还没有保存的 prompt，可以去「Prompt 管理」创建，或选「自定义」直接写。
                </p>
              )}
            </div>
          )}

          {/* custom 模式：直接输 prompt */}
          {crossMode === "custom" && (
            <div>
              <Textarea
                size="sm"
                label="自定义 Prompt"
                placeholder={"请把以下原文改写为...\n\n要求：...\n\n原文：\n{content}"}
                description="必须包含 {content} 占位符——它会被原文正文替换。"
                minRows={6}
                value={crossPromptText}
                onValueChange={setCrossPromptText}
              />
            </div>
          )}

          {/* 变体数量 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-default-500">变体数量：</span>
            {[1, 3, 5].map((n) => (
              <Chip key={n} size="sm"
                variant={crossVariantCount === n ? "solid" : "flat"}
                color={crossVariantCount === n ? "primary" : "default"}
                className="cursor-pointer"
                onClick={() => setCrossVariantCount(n)}>
                {n}
              </Chip>
            ))}
          </div>

          {/* 错误提示 */}
          {crossError && (
            <p className="text-sm text-danger">{crossError}</p>
          )}

          {/* 改写中 */}
          {crossLoading && (
            <div className="text-center py-8 text-default-500">
              AI 改写中…（公众号长文，请稍候 10-30s）
            </div>
          )}

          {/* 结果 */}
          {!crossLoading && crossVariants.length > 0 && (
            <>
              <p className="text-xs text-default-500">
                生成了 {crossVariants.length} 个不同温度的变体，挑一个复制使用：
              </p>
              {crossVariants.map((v, i) => (
                <div key={i} className="rounded-lg p-3 border bg-default-50 border-default-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-default-500">变体 #{i + 1}</span>
                    <Tooltip content="复制到剪贴板">
                      <Button isIconOnly size="sm" variant="flat"
                        onPress={async () => {
                          await navigator.clipboard.writeText(v);
                        }}>
                        <Copy size={14} />
                      </Button>
                    </Tooltip>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm text-default-700 font-sans">{v}</pre>
                </div>
              ))}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>关闭</Button>
          <Button color="primary"
            startContent={<Wand2 size={14} />}
            onPress={onRun}
            isLoading={crossLoading}
            isDisabled={crossLoading}>
            开始改写
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
