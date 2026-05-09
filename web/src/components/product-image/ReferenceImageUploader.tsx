"use client";

import { useRef, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Upload, X, Image as ImageIcon } from "lucide-react";
import { toastErr } from "@/lib/toast";

type Props = {
  b64: string;
  preview: string;
  name: string;
  onChange: (b64: string, preview: string, name: string) => void;
  description?: string;
};

/** 参考图上传 + 预览 + 移除。父组件管 state，本组件只管 UI 和 file → b64 转换。 */
export function ReferenceImageUploader({
  b64, preview, name, onChange, description,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      toastErr("请上传图片文件（PNG / JPG / WEBP）");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toastErr("图片不能超过 10 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      const newB64 = result.split(",")[1] || "";
      onChange(newB64, result, file.name);
    };
    reader.readAsDataURL(file);
  };

  const clear = () => {
    onChange("", "", "");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <ImageIcon size={18} className="text-default-500" />
        <span className="font-semibold">参考图（可选）</span>
      </CardHeader>
      <CardBody className="space-y-3">
        {description && (
          <p className="text-xs text-default-500">{description}</p>
        )}
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {preview ? (
          <div className="relative inline-block">
            <img
              src={preview}
              alt={name}
              className="max-h-64 rounded-md border border-divider"
            />
            <button
              type="button"
              onClick={clear}
              className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-danger text-white flex items-center justify-center shadow-md hover:bg-danger-600"
              title="移除"
            >
              <X size={14} />
            </button>
            <p className="text-xs text-default-500 mt-1 truncate max-w-[256px]">
              {name}
            </p>
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFile(f);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-divider hover:border-primary/40"
            }`}
          >
            <Upload size={28} className="mx-auto text-default-400 mb-2" />
            <p className="text-sm text-default-600">
              点击或拖拽图片到这里
            </p>
            <p className="text-xs text-default-400 mt-1">
              PNG / JPG / WEBP，最大 10 MB
            </p>
          </div>
        )}
        <p className="text-xs text-default-400">
          上传参考图后将调用 <code>/images/edits</code> 端点，需要图像模型支持图片编辑（如 gpt-image-1）。
        </p>
      </CardBody>
    </Card>
  );
}
