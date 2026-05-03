"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Textarea } from "@nextui-org/input";
import { Select, SelectItem } from "@nextui-org/select";
import { Chip } from "@nextui-org/chip";

type Account = { id: number; name: string };
type Group = { id: number; name: string; is_builtin: number };
type AddResult = { link: string; ok: boolean; reason?: string };

export type AddPostsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  groups: Group[];
  accounts: Account[];
  links: string;
  setLinks: (v: string) => void;
  selectedGroupId: string;
  setSelectedGroupId: (v: string) => void;
  selectedAccount: string;
  setSelectedAccount: (v: string) => void;
  addResults: AddResult[];
  adding: boolean;
  onSubmit: () => void;
};

export default function AddPostsModal({
  isOpen, onClose, groups, accounts,
  links, setLinks, selectedGroupId, setSelectedGroupId,
  selectedAccount, setSelectedAccount, addResults, adding, onSubmit,
}: AddPostsModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>添加小红书帖子链接</ModalHeader>
        <ModalBody className="space-y-4">
          <Select
            label="分组"
            placeholder="选择分组"
            selectedKeys={selectedGroupId ? new Set([selectedGroupId]) : new Set()}
            onSelectionChange={(keys) => setSelectedGroupId(Array.from(keys)[0] as string ?? "")}
          >
            {groups.map((g) => (
              <SelectItem key={String(g.id)}>{g.name}</SelectItem>
            ))}
          </Select>
          <Textarea
            label="帖子链接"
            placeholder={"每行粘贴一个小红书链接：\n- xhslink.com/...\n- xiaohongshu.com/explore/{id}\n- xiaohongshu.com/discovery/item/{id}"}
            value={links}
            onValueChange={setLinks}
            minRows={5}
          />
          {accounts.length > 0 && (
            <Select
              label="绑定账号（可选）"
              placeholder="不选则不使用 Cookie 抓取"
              selectedKeys={selectedAccount ? new Set([selectedAccount]) : new Set()}
              onSelectionChange={(keys) => setSelectedAccount(Array.from(keys)[0] as string ?? "")}
            >
              {accounts.map((a) => (
                <SelectItem key={String(a.id)}>{a.name}</SelectItem>
              ))}
            </Select>
          )}

          {addResults.length > 0 && (
            <div className="space-y-1">
              {addResults.map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <Chip size="sm" color={r.ok ? "success" : "danger"} variant="flat">
                    {r.ok ? "成功" : "失败"}
                  </Chip>
                  <span className="truncate text-default-500">{r.link}</span>
                  {r.reason && <span className="text-danger text-xs">{r.reason}</span>}
                </div>
              ))}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>取消</Button>
          <Button color="primary" isLoading={adding} onPress={onSubmit}>
            解析并添加
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
