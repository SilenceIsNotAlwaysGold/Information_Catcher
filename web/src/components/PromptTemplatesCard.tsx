"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Input, Textarea } from "@nextui-org/input";
import { Chip } from "@nextui-org/chip";
import {
  Table, TableHeader, TableColumn, TableBody, TableRow, TableCell,
} from "@nextui-org/table";
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, useDisclosure,
} from "@nextui-org/modal";
import { Plus, Pencil, Trash2, Star, Wand2 } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { TableSkeleton } from "./TableSkeleton";

type Prompt = {
  id: number;
  name: string;
  content: string;
  is_default: number;
  created_at: string;
};

const API = (path: string) => `/api/monitor${path}`;

export function PromptTemplatesCard({ token }: { token: string | null }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const editor = useDisclosure();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(API("/prompts"), { headers });
      const d = await r.json();
      setPrompts(d.prompts ?? []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (token) load(); }, [token]);

  const openCreate = () => {
    setEditingId(null); setName(""); setContent("{content}");
    editor.onOpen();
  };
  const openEdit = (p: Prompt) => {
    setEditingId(p.id); setName(p.name); setContent(p.content);
    editor.onOpen();
  };

  const save = async () => {
    if (!name.trim() || !content.trim()) return;
    setSaving(true);
    if (editingId == null) {
      await fetch(API("/prompts"), {
        method: "POST", headers,
        body: JSON.stringify({ name, content }),
      });
    } else {
      await fetch(API(`/prompts/${editingId}`), {
        method: "PATCH", headers,
        body: JSON.stringify({ name, content }),
      });
    }
    setSaving(false);
    editor.onClose();
    await load();
  };

  const remove = async (id: number) => {
    const ok = await confirmDialog({
      title: "删除 Prompt",
      content: "确认删除该 prompt？",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    await fetch(API(`/prompts/${id}`), { method: "DELETE", headers });
    await load();
  };

  const setDefault = async (id: number) => {
    await fetch(API(`/prompts/${id}/set-default`), { method: "POST", headers });
    await load();
  };

  return (
    <>
      <Card>
        <CardHeader className="flex justify-between items-center">
          <span className="font-semibold">改写 Prompt 模板</span>
          <Button size="sm" color="primary" variant="flat"
            startContent={<Plus size={14} />} onPress={openCreate}>
            新建
          </Button>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <TableSkeleton rows={3} cols={4} />
          ) : prompts.length === 0 ? (
            <EmptyState
              icon={Wand2}
              title="暂无 Prompt 模板"
              hint="新建一个改写 Prompt（必须包含 {content} 占位符），可在改写时选用。"
              action={
                <Button color="primary" variant="flat" startContent={<Plus size={14} />}
                  onPress={openCreate}>
                  新建 Prompt
                </Button>
              }
            />
          ) : (
            <Table aria-label="prompts" removeWrapper>
              <TableHeader>
                <TableColumn>名称</TableColumn>
                <TableColumn>内容预览</TableColumn>
                <TableColumn>默认</TableColumn>
                <TableColumn>操作</TableColumn>
              </TableHeader>
              <TableBody>
                {prompts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><span className="text-sm font-medium">{p.name}</span></TableCell>
                    <TableCell>
                      <span className="text-xs text-default-500 line-clamp-1 max-w-md block">
                        {p.content}
                      </span>
                    </TableCell>
                    <TableCell>
                      {p.is_default ? (
                        <Chip size="sm" color="success" variant="flat">默认</Chip>
                      ) : (
                        <Button size="sm" variant="light"
                          startContent={<Star size={14} />}
                          onPress={() => setDefault(p.id)}>
                          设为默认
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button isIconOnly size="sm" variant="light"
                          onPress={() => openEdit(p)}><Pencil size={15} /></Button>
                        <Button isIconOnly size="sm" variant="light" color="danger"
                          onPress={() => remove(p.id)}><Trash2 size={15} /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Modal isOpen={editor.isOpen} onClose={editor.onClose} size="2xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>{editingId == null ? "新建 Prompt" : "编辑 Prompt"}</ModalHeader>
          <ModalBody className="space-y-3">
            <Input label="名称" placeholder="例：小红书爆款风格"
              value={name} onValueChange={setName} />
            <Textarea
              label="Prompt 内容"
              description="必须包含 {content} 占位符；改写时会替换成原帖正文"
              value={content} onValueChange={setContent} minRows={6}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={editor.onClose}>取消</Button>
            <Button color="primary" isLoading={saving} onPress={save}
              isDisabled={!name.trim() || !content.includes("{content}")}>
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
