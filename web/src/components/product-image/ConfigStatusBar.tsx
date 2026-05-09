"use client";

import { Card, CardBody } from "@nextui-org/card";
import { Settings as SettingsIcon } from "lucide-react";
import { ImageApiConfigButton } from "@/components/ImageApiConfigButton";
import { ImageConfig } from "./utils";

type Props = {
  cfg: ImageConfig;
  loading: boolean;
  isAdmin: boolean;
  onSaved: () => void;
};

/** 顶部"图像 API 配置"状态条：未配置时给提示，admin 给配置按钮。 */
export function ConfigStatusBar({ cfg, loading, isAdmin, onSaved }: Props) {
  return (
    <Card className={cfg.has_key ? "border-success/30" : "border-warning/30"}>
      <CardBody className="flex flex-row items-center gap-3 py-3">
        <SettingsIcon size={18} className="text-default-400 shrink-0" />
        <div className="flex-1 min-w-0">
          {loading ? (
            <span className="text-sm text-default-500">加载配置中…</span>
          ) : cfg.has_key ? (
            <span className="text-sm text-default-600">
              图像 API 已配置
              {cfg.model && (
                <span className="text-default-400 ml-2">
                  model: {cfg.model} · size: {cfg.size}
                </span>
              )}
            </span>
          ) : (
            <span className="text-sm text-warning-600">
              {isAdmin
                ? "图像 API 尚未配置，请在「系统配置」中填写"
                : "图像 API 尚未配置，请联系管理员开启"}
            </span>
          )}
        </div>
        {isAdmin && <ImageApiConfigButton hasKey={cfg.has_key} onSaved={onSaved} />}
      </CardBody>
    </Card>
  );
}
