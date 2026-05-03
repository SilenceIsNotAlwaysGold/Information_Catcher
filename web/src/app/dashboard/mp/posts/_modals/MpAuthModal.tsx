"use client";

import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter,
} from "@nextui-org/modal";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Key } from "lucide-react";

export type AuthForm = {
  uin: string;
  key: string;
  pass_ticket: string;
  appmsg_token: string;
};

export type MpAuthModalProps = {
  isOpen: boolean;
  onClose: () => void;
  authForm: AuthForm;
  setAuthForm: React.Dispatch<React.SetStateAction<AuthForm>>;
  authStatus: { has_auth: boolean; mp_auth_at: string | null };
  authSaving: boolean;
  onSubmit: () => void;
};

export default function MpAuthModal({
  isOpen, onClose, authForm, setAuthForm, authStatus, authSaving, onSubmit,
}: MpAuthModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Key size={18} className="text-warning" />
          录入公众号客户端凭证
          <Chip size="sm" variant="flat">v1 手动模式</Chip>
        </ModalHeader>
        <ModalBody className="space-y-3">
          <div className="text-sm text-default-600 space-y-2 bg-default-50 rounded-lg p-3">
            <p className="font-medium">为什么要录入凭证？</p>
            <p className="text-xs text-default-500">
              公众号阅读数 / 在看数只能通过模拟客户端抓取，需要 <code>uin / key / pass_ticket / appmsg_token</code> 4 个字段，
              key 大约 30 分钟过期，过期后需要重新录入。
            </p>
            <p className="font-medium pt-1">如何获取？</p>
            <ol className="text-xs text-default-500 ml-4 space-y-0.5 list-decimal">
              <li>用 Charles / Fiddler / mitmproxy 抓微信包（手机和电脑同一 wifi 配代理）</li>
              <li>在微信里打开任意公众号文章</li>
              <li>找到 <code>/mp/getappmsgext</code> 请求，从 URL 参数复制 uin / key / pass_ticket / appmsg_token</li>
              <li>粘贴到下面输入框保存</li>
            </ol>
            <p className="text-xs text-warning">
              ⚠️ key 过期后调用会失败、显示阅读数 0；管理员可考虑接 NewRank SaaS（issue #23）避免维护
            </p>
          </div>
          <Input label="uin" placeholder="MzXxxxxxx 或纯数字"
            value={authForm.uin}
            onValueChange={(v) => setAuthForm((f) => ({ ...f, uin: v }))} />
          <Input label="key" placeholder="abc..." type="password"
            value={authForm.key}
            onValueChange={(v) => setAuthForm((f) => ({ ...f, key: v }))} />
          <Input label="pass_ticket（可选）" placeholder="abc..."
            value={authForm.pass_ticket}
            onValueChange={(v) => setAuthForm((f) => ({ ...f, pass_ticket: v }))} />
          <Input label="appmsg_token（可选）" placeholder="abc..."
            value={authForm.appmsg_token}
            onValueChange={(v) => setAuthForm((f) => ({ ...f, appmsg_token: v }))} />
          <p className="text-xs text-default-400">
            {authStatus.has_auth
              ? `当前凭证更新于 ${authStatus.mp_auth_at?.slice(0, 16)}（提交新值会覆盖）`
              : "尚未录入凭证。无凭证时阅读数显示为 0，但文章正文/标题/摘要等仍然可抓。"}
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>取消</Button>
          <Button color="primary" onPress={onSubmit} isLoading={authSaving}
            isDisabled={!authForm.uin || !authForm.key}>
            保存凭证
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
