"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import { Spinner } from "@nextui-org/spinner";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Ticket, Plus, RefreshCw, Trash2, Copy, Link2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastErr, toastOk } from "@/lib/toast";

const PLANS = ["trial", "free", "pro", "team", "enterprise"];

type Invite = {
  code: string;
  created_by: number | null;
  plan: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  note: string;
  created_at: string;
};

export default function AdminInvitesPage() {
  const { token } = useAuth();
  const headers = useMemo(
    () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    [token],
  );

  const [items, setItems] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch("/api/auth/admin/invites", { headers });
      const data = await r.json();
      if (Array.isArray(data?.invites)) setItems(data.invites);
    } catch (e: any) { toastErr(`加载失败：${e?.message || e}`); }
    finally { setLoading(false); }
  }, [token, headers]);

  useEffect(() => { reload(); }, [reload]);

  const createModal = useDisclosure();
  const [form, setForm] = useState({ plan: "trial", max_uses: 1, expires_in_days: 30, note: "" });

  const handleCreate = async () => {
    try {
      const r = await fetch("/api/auth/admin/invites", {
        method: "POST", headers,
        body: JSON.stringify(form),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { toastErr(data?.detail || `HTTP ${r.status}`); return; }
      toastOk(`已生成：${data.code}`);
      navigator.clipboard.writeText(data.code).catch(() => {});
      createModal.onClose();
      setForm({ plan: "trial", max_uses: 1, expires_in_days: 30, note: "" });
      await reload();
    } catch (e: any) { toastErr(`生成失败：${e?.message || e}`); }
  };

  const handleDelete = async (code: string) => {
    if (!confirm(`确认删除邀请码 ${code}？`)) return;
    try {
      const r = await fetch(`/api/auth/admin/invites/${code}`, { method: "DELETE", headers });
      const data = await r.json();
      if (data?.ok) {
        toastOk("已删除");
        setItems((prev) => prev.filter((i) => i.code !== code));
      } else { toastErr("删除失败"); }
    } catch (e: any) { toastErr(`删除失败：${e?.message || e}`); }
  };

  const buildLink = (code: string) => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    return `${base}/register?invite=${code}`;
  };

  const copyLink = (code: string) => {
    navigator.clipboard.writeText(buildLink(code)).then(() => toastOk("已复制邀请链接"));
  };

  const isExpired = (i: Invite) => {
    if (!i.expires_at) return false;
    try { return new Date(i.expires_at).getTime() < Date.now(); } catch { return false; }
  };
  const isExhausted = (i: Invite) => i.used_count >= i.max_uses;

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-secondary/10 text-secondary p-3">
          <Ticket size={24} />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">邀请码管理</h1>
          <p className="text-sm text-default-500 mt-1">
            生成邀请码控制注册。注册时邀请码自带的套餐会覆盖默认 trial。
          </p>
        </div>
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="flat" startContent={<RefreshCw size={14} />}
              onPress={reload} isLoading={loading}>刷新</Button>
            <Button size="sm" color="primary" startContent={<Plus size={14} />}
              onPress={createModal.onOpen}>生成邀请码</Button>
          </div>
          {loading && items.length === 0 ? (
            <div className="py-12 flex justify-center"><Spinner /></div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-default-500 border-b border-divider">
                  <th className="py-2 pr-2">邀请码</th>
                  <th className="py-2 pr-2">套餐</th>
                  <th className="py-2 pr-2">使用</th>
                  <th className="py-2 pr-2">过期</th>
                  <th className="py-2 pr-2">备注</th>
                  <th className="py-2 pr-2">创建时间</th>
                  <th className="py-2 pr-2">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.code} className="border-b border-divider/50 hover:bg-default-50">
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-sm">{i.code}</code>
                        {isExpired(i) && <Chip size="sm" color="danger" variant="flat">已过期</Chip>}
                        {isExhausted(i) && !isExpired(i) && <Chip size="sm" color="warning" variant="flat">已用完</Chip>}
                      </div>
                    </td>
                    <td className="py-2 pr-2">{i.plan}</td>
                    <td className="py-2 pr-2">{i.used_count} / {i.max_uses}</td>
                    <td className="py-2 pr-2 text-xs text-default-500">{i.expires_at || "永不"}</td>
                    <td className="py-2 pr-2 max-w-[200px] truncate">{i.note || "-"}</td>
                    <td className="py-2 pr-2 text-xs text-default-400">{i.created_at}</td>
                    <td className="py-2 pr-2">
                      <div className="flex gap-1">
                        <Button size="sm" variant="light" isIconOnly title="复制邀请链接"
                          onPress={() => copyLink(i.code)}>
                          <Link2 size={14} />
                        </Button>
                        <Button size="sm" variant="light" isIconOnly title="复制邀请码"
                          onPress={() => {
                            navigator.clipboard.writeText(i.code);
                            toastOk("已复制");
                          }}>
                          <Copy size={14} />
                        </Button>
                        <Button size="sm" variant="light" isIconOnly title="删除"
                          color="danger" onPress={() => handleDelete(i.code)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-default-400">
                      还没有邀请码
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Modal isOpen={createModal.isOpen} onClose={createModal.onClose}>
        <ModalContent>
          <ModalHeader>生成邀请码</ModalHeader>
          <ModalBody className="space-y-3">
            <div>
              <label className="text-sm text-default-700">套餐</label>
              <select className="w-full mt-1 border border-divider rounded-md p-2 text-sm bg-background"
                value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <Input label="可用次数" type="number" min={1} value={String(form.max_uses)}
              onValueChange={(v) => setForm({ ...form, max_uses: parseInt(v, 10) || 1 })} />
            <Input label="有效天数（0 表示永不过期）" type="number" min={0}
              value={String(form.expires_in_days)}
              onValueChange={(v) => setForm({ ...form, expires_in_days: parseInt(v, 10) || 0 })} />
            <Input label="备注（可选）" placeholder="例：给小明的内推码"
              value={form.note} onValueChange={(v) => setForm({ ...form, note: v })} />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={createModal.onClose}>取消</Button>
            <Button color="primary" onPress={handleCreate}>生成</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
