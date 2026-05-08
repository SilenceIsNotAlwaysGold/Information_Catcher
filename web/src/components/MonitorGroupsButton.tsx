"use client";

/**
 * 监控分组按钮 + Modal 包装
 * 用于 posts 页右上角，把原本「监控设置 → 监控分组」的卡片就近到帖子分组场景。
 */
import { Button } from "@nextui-org/button";
import {
  Modal, ModalContent, ModalHeader, ModalBody, useDisclosure,
} from "@nextui-org/modal";
import { Layers } from "lucide-react";
import { MonitorGroupsCard } from "./MonitorGroupsCard";

export function MonitorGroupsButton({ token }: { token: string | null }) {
  const modal = useDisclosure();
  return (
    <>
      <Button
        variant="flat"
        size="sm"
        startContent={<Layers size={15} />}
        onPress={modal.onOpen}
      >
        分组管理
      </Button>
      <Modal
        isOpen={modal.isOpen}
        onClose={modal.onClose}
        size="3xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader className="flex items-center gap-2">
            <Layers size={18} />
            监控分组（分组级 webhook + 阈值）
          </ModalHeader>
          <ModalBody className="pb-6">
            <MonitorGroupsCard token={token} />
          </ModalBody>
        </ModalContent>
      </Modal>
    </>
  );
}
