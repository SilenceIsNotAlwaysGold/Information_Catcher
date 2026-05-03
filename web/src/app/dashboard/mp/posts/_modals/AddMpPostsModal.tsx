"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Textarea } from "@nextui-org/input";

type AddResult = { link: string; ok: boolean; reason?: string };

export type AddMpPostsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  links: string;
  setLinks: (v: string) => void;
  results: AddResult[];
  adding: boolean;
  onSubmit: () => void;
};

export default function AddMpPostsModal({
  isOpen, onClose, links, setLinks, results, adding, onSubmit,
}: AddMpPostsModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>添加公众号文章</ModalHeader>
        <ModalBody>
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
          <Button color="primary" onPress={onSubmit} isLoading={adding}>添加</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
