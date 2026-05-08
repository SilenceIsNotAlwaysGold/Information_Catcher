"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";

type AddResult = { link: string; ok: boolean; reason?: string };
type Group = { id: number; name: string; is_builtin: number };

export type AddMpPostsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  selectedGroupId: string;
  setSelectedGroupId: (v: string) => void;
  links: string;
  setLinks: (v: string) => void;
  results: AddResult[];
  adding: boolean;
  onSubmit: () => void;
};

export default function AddMpPostsModal({
  isOpen, onClose, groups, selectedGroupId, setSelectedGroupId,
  links, setLinks, results, adding, onSubmit,
}: AddMpPostsModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>添加公众号文章</ModalHeader>
        <ModalBody className="space-y-4">
          <Select
            label="分组"
            placeholder="必选：选择一个分组"
            isRequired
            isInvalid={!selectedGroupId}
            errorMessage={!selectedGroupId ? "请选择一个分组（不选无法添加）" : undefined}
            selectedKeys={selectedGroupId ? new Set([selectedGroupId]) : new Set()}
            onSelectionChange={(keys) => setSelectedGroupId(Array.from(keys)[0] as string ?? "")}
          >
            {groups.map((g) => (
              <SelectItem key={String(g.id)}>{g.name}</SelectItem>
            ))}
          </Select>
          <Textarea
            label="文章链接（每行一个）"
            placeholder={"https://mp.weixin.qq.com/s?__biz=...&mid=...&idx=...\n或 https://mp.weixin.qq.com/s/HASH"}
            value={links} onValueChange={setLinks} minRows={4}
          />
          {results.length > 0 && (
            <div className="text-xs space-y-1">
              {results.map((r, i) => (
                <div key={i} className={r.ok ? "text-success" : "text-danger"}>
                  {r.ok ? "✓" : "✗"} {r.link.slice(0, 60)}{r.reason ? ` — ${r.reason}` : ""}
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>取消</Button>
          <Button
            color="primary"
            onPress={onSubmit}
            isLoading={adding}
            isDisabled={!selectedGroupId || !links.trim()}
          >
            添加
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
