"use client";

import {
  Modal, ModalContent, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Download, X } from "lucide-react";
import { proxyUrl } from "./utils";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  src: string;             // 原始 URL（http/https/data:）
  alt?: string;
  onDownload?: () => void;
};

/** 点击图片打开的全屏预览 + 下载按钮。 */
export function ImagePreviewModal({ isOpen, onClose, src, alt, onDownload }: Props) {
  if (!isOpen) return null;
  const display = src.startsWith("data:") ? src : proxyUrl(src);
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" backdrop="blur">
      <ModalContent>
        <ModalBody className="p-2">
          <img
            src={display}
            alt={alt || "preview"}
            className="w-full max-h-[70vh] object-contain rounded-md"
          />
        </ModalBody>
        <ModalFooter className="justify-between">
          <Button variant="flat" onPress={onClose} startContent={<X size={16} />}>
            关闭
          </Button>
          {onDownload && (
            <Button
              color="primary"
              startContent={<Download size={16} />}
              onPress={onDownload}
            >
              下载
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
