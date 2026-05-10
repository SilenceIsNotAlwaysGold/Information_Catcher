"use client";

/**
 * 单行帖子的「移动到其他分组」按钮（图标 + 下拉菜单）。
 *
 * 用法：
 *   <MoveGroupButton
 *     noteId={p.note_id}
 *     currentGroupId={p.group_id}
 *     groups={groups}
 *     onMoved={() => mutatePosts()}
 *   />
 */
import { useState } from "react";
import {
  Dropdown, DropdownTrigger, DropdownMenu, DropdownItem,
} from "@nextui-org/dropdown";
import { Button } from "@nextui-org/button";
import { Tooltip } from "@nextui-org/tooltip";
import { FolderInput, Check } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastOk, toastErr } from "@/lib/toast";

type Group = { id: number; name: string };

export function MoveGroupButton({
  noteId, currentGroupId, groups, onMoved, ownerUserId,
}: {
  noteId: string;
  currentGroupId: number | null;
  groups: Group[];
  onMoved: () => void;
  /** admin 给别人改分组时传 owner（前端目前不强制；后端 _scope_uid 已限制） */
  ownerUserId?: number | null;
}) {
  const { token } = useAuth();
  const [moving, setMoving] = useState(false);

  const handleMove = async (gid: number | null) => {
    if (gid === currentGroupId) return;
    setMoving(true);
    try {
      const r = await fetch(`/api/monitor/posts/${noteId}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ group_id: gid }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toastErr(data.detail || `HTTP ${r.status}`);
        return;
      }
      const target = gid == null ? "未分组" : (groups.find((g) => g.id === gid)?.name || "新分组");
      toastOk(`已移动到「${target}」`);
      onMoved();
    } catch (e: any) {
      toastErr(`移动失败：${e?.message || e}`);
    } finally { setMoving(false); }
  };

  return (
    <Dropdown placement="bottom-end">
      <Tooltip content="移动到其他分组">
        <DropdownTrigger>
          <Button isIconOnly size="sm" variant="light" isLoading={moving}
            aria-label="移动分组">
            <FolderInput size={15} />
          </Button>
        </DropdownTrigger>
      </Tooltip>
      <DropdownMenu
        aria-label="选择目标分组"
        onAction={(key) => {
          const v = String(key);
          handleMove(v === "_none" ? null : parseInt(v, 10));
        }}
      >
        <>
          <DropdownItem
            key="_none"
            startContent={currentGroupId == null ? <Check size={13} /> : <span className="w-[13px]" />}
            description={currentGroupId == null ? "当前分组" : undefined}
          >
            未分组
          </DropdownItem>
          {(groups || []).map((g) => (
            <DropdownItem
              key={String(g.id)}
              startContent={currentGroupId === g.id ? <Check size={13} /> : <span className="w-[13px]" />}
              description={currentGroupId === g.id ? "当前分组" : undefined}
            >
              {g.name}
            </DropdownItem>
          ))}
        </>
      </DropdownMenu>
    </Dropdown>
  );
}
