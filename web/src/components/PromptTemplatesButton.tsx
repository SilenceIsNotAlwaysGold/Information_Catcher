"use client";

/**
 * Prompt 模板按钮 + Modal 包装
 * 用于 trending 页右上角，把原本「监控设置 → Prompt 管理」的卡片就近到改写场景。
 */
import { Button } from "@nextui-org/button";
import {
  Modal, ModalContent, ModalHeader, ModalBody, useDisclosure,
} from "@nextui-org/modal";
import { Wand2 } from "lucide-react";
import { PromptTemplatesCard } from "./PromptTemplatesCard";

export function PromptTemplatesButton({ token }: { token: string | null }) {
  const modal = useDisclosure();
  return (
    <>
      <Button
        variant="flat"
        size="sm"
        startContent={<Wand2 size={15} />}
        onPress={modal.onOpen}
      >
        Prompt 模板
      </Button>
      <Modal
        isOpen={modal.isOpen}
        onClose={modal.onClose}
        size="3xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Wand2 size={18} />
            改写 Prompt 模板
          </ModalHeader>
          <ModalBody className="pb-6">
            <PromptTemplatesCard token={token} />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
