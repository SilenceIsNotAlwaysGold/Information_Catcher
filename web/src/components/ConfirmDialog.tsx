"use client";

// 命令式 Confirm 弹窗 —— 替代浏览器 confirm()
// 用法：
//   const ok = await confirmDialog({
//     title: "取消订阅",
//     content: "已抓到的帖子会保留",
//     confirmText: "取消订阅",
//     cancelText: "保留",
//     danger: true,
//   });
//   if (!ok) return;
//
// 实现：动态挂载一个 React Root + NextUI Modal，Promise 在用户点击后 resolve。
// NextUI Modal 自动跟随 next-themes 的暗色模式。

import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { NextUIProvider } from "@nextui-org/system";
import { ThemeProvider as NextThemesProvider } from "next-themes";

export type ConfirmOptions = {
  title?: string;
  content?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type Props = ConfirmOptions & {
  onClose: (result: boolean) => void;
};

function ConfirmDialogView({
  title = "确认操作",
  content,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onClose,
}: Props) {
  // 受控开关：先 mount 关闭态，立刻打开，触发 NextUI 进入动画
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(true);
  }, []);

  const handle = (ok: boolean) => {
    setOpen(false);
    // 等出场动画播完再卸载，避免闪烁
    setTimeout(() => onClose(ok), 200);
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => handle(false)}
      placement="center"
      backdrop="opaque"
      size="sm"
    >
      <ModalContent>
        <ModalHeader className="text-base">{title}</ModalHeader>
        {content !== undefined && content !== null && content !== "" && (
          <ModalBody>
            <div className="text-sm text-default-600">{content}</div>
          </ModalBody>
        )}
        <ModalFooter>
          <Button variant="flat" onPress={() => handle(false)} size="sm">
            {cancelText}
          </Button>
          <Button
            color={danger ? "danger" : "primary"}
            onPress={() => handle(true)}
            size="sm"
          >
            {confirmText}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function confirmDialog(options: ConfirmOptions = {}): Promise<boolean> {
  // SSR 守护
  if (typeof window === "undefined") return Promise.resolve(false);

  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: Root | null = createRoot(host);

    const cleanup = (result: boolean) => {
      try {
        root?.unmount();
      } finally {
        root = null;
        host.remove();
      }
      resolve(result);
    };

    root.render(
      <NextUIProvider>
        <NextThemesProvider attribute="class" defaultTheme="light" enableSystem={false}>
          <ConfirmDialogView {...options} onClose={cleanup} />
        </NextThemesProvider>
      </NextUIProvider>,
    );
  });
}
