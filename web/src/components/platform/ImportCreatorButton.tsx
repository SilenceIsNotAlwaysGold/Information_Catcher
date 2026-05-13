"use client";

/**
 * 一键从博主主页导入所有作品到监控列表。
 *
 * 走浏览器扩展通道：POST /api/monitor/posts/import-from-creator
 * 跟「博主追新」的区别：不在 monitor_creators 表里建订阅，纯一次性导入。
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@nextui-org/button";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Input } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Spinner } from "@nextui-org/spinner";
import { Users, Download } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

type Group = { id: number; name: string };

type Props = {
  platform: "xhs" | "douyin";
  onImported?: () => void;   // 导入完成后让上层刷新列表
};

export function ImportCreatorButton({ platform, onImported }: Props) {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );
  const modal = useDisclosure();
  const [url, setUrl] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [maxCount, setMaxCount] = useState<string>("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadGroups = async () => {
    if (!token) return;
    setLoadingGroups(true);
    try {
      const r = await fetch(`/api/monitor/groups?platform=${platform}`, { headers });
      if (r.ok) {
        const d = await r.json();
        const gs = (d.groups || []).map((g: any) => ({ id: g.id, name: g.name }));
        setGroups(gs);
        if (gs.length > 0 && !groupId) setGroupId(String(gs[0].id));
      }
    } finally { setLoadingGroups(false); }
  };

  useEffect(() => {
    if (modal.isOpen) loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.isOpen, platform]);

  const handleSubmit = async () => {
    const u = url.trim();
    if (!u) { toastErr("请输入博主主页 URL"); return; }
    if (!groupId) { toastErr("请选择分组"); return; }
    setSubmitting(true);
    try {
      const body: any = {
        creator_url: u,
        platform,
        group_id: parseInt(groupId, 10),
      };
      const mc = parseInt(maxCount, 10);
      if (!isNaN(mc) && mc > 0) body.max_count = mc;
      const r = await fetch("/api/monitor/posts/import-from-creator", {
        method: "POST", headers, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        toastErr(d.detail || "导入失败");
        return;
      }
      const author = d.creator_name ? `（${d.creator_name}）` : "";
      const warn = d.warning ? `\n${d.warning}` : "";
      toastOk(
        `${author}抓到 ${d.fetched} 条，新增 ${d.added}，跳过重复 ${d.skipped}${warn}`
      );
      setUrl("");
      setMaxCount("");
      modal.onClose();
      onImported?.();
    } catch (e: any) {
      toastErr(`导入异常：${e?.message || e}`);
    } finally { setSubmitting(false); }
  };

  return (
    <>
      <Button size="sm" variant="flat" color="secondary"
        startContent={<Users size={14} />}
        onPress={modal.onOpen}>
        导入博主全部作品
      </Button>
      <Modal isOpen={modal.isOpen} onClose={modal.onClose} size="lg">
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Users size={18} /> 一键导入博主作品（{platform === "xhs" ? "小红书" : "抖音"}）
          </ModalHeader>
          <ModalBody className="space-y-3">
            <p className="text-xs text-default-500">
              通过浏览器扩展抓博主主页的所有作品，批量加入下方选中的监控分组。
              前提：已安装 TrendPulse Helper 扩展，浏览器登录目标平台。
            </p>
            <Input label="博主主页 URL" labelPlacement="outside" size="sm"
              placeholder={
                platform === "xhs"
                  ? "https://www.xiaohongshu.com/user/profile/xxxx"
                  : "https://www.douyin.com/user/MS4wLjABxxx"
              }
              value={url} onValueChange={setUrl} />
            <div className="flex gap-2">
              <Select label="入哪个分组" labelPlacement="outside" size="sm"
                isLoading={loadingGroups}
                selectedKeys={groupId ? [groupId] : []}
                onSelectionChange={(keys) => {
                  const v = Array.from(keys)[0];
                  if (v) setGroupId(String(v));
                }}
                className="flex-1">
                {groups.map((g) => (
                  <SelectItem key={String(g.id)}>{g.name}</SelectItem>
                ))}
              </Select>
              <Input label="数量上限（可选）" labelPlacement="outside" size="sm"
                placeholder="留空 = 扩展返回多少都导"
                value={maxCount} onValueChange={setMaxCount}
                type="number" className="w-44" />
            </div>
            <p className="text-[11px] text-default-400">
              小红书博主主页一次约 20-30 条；抖音约 30-60 条（懒加载，扩展会下拉到底）。
              重复 note_id 自动跳过。
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={modal.onClose}>取消</Button>
            <Button color="primary" isLoading={submitting}
              startContent={!submitting ? <Download size={14} /> : undefined}
              onPress={handleSubmit}>
              开始导入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
