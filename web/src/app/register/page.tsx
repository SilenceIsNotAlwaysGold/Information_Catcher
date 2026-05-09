"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input } from "@nextui-org/input";
import { Button } from "@nextui-org/button";
import { Eye, EyeOff, Ticket, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f9fafb]" />}>
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { register } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [allowSelfRegister, setAllowSelfRegister] = useState<boolean | null>(null);

  // 从 URL 拿邀请码（admin 复制的链接 /register?invite=ABC）
  useEffect(() => {
    const code = searchParams?.get("invite") || "";
    if (code) setInviteCode(code.trim().toUpperCase());
  }, [searchParams]);

  // 拉取注册策略：是否允许自助注册
  useEffect(() => {
    fetch("/api/auth/public/register-config")
      .then((r) => r.json())
      .then((d) => setAllowSelfRegister(!!d?.allow_self_register))
      .catch(() => setAllowSelfRegister(true));
  }, []);

  const inviteRequired = allowSelfRegister === false;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email || !password) { setError("邮箱和密码必填"); return; }
    if (password.length < 6) { setError("密码至少 6 位"); return; }
    if (password !== confirm) { setError("两次输入的密码不一致"); return; }
    if (inviteRequired && !inviteCode.trim()) {
      setError("当前需要邀请码才能注册");
      return;
    }
    setLoading(true);
    try {
      await register(email, password, inviteCode.trim() || undefined);
      router.push("/dashboard");
    } catch (e: any) {
      setError(e?.message || "注册失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f9fafb] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-primary mb-4 shadow-lg shadow-primary/30">
            <span className="text-white font-bold text-xl">P</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">注册 Pulse 账号</h1>
          <p className="text-sm text-gray-400 mt-1">
            {inviteRequired
              ? "当前需要邀请码才能注册"
              : "注册即享 14 天免费试用"}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={inviteRequired ? "邀请码（必填）" : "邀请码（可选）"}
              placeholder="例：A2B3CD4E5FGH"
              value={inviteCode}
              onValueChange={(v) => setInviteCode(v.toUpperCase())}
              variant="bordered"
              startContent={<Ticket size={14} className="text-gray-400" />}
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
              isRequired={inviteRequired}
            />
            <Input
              label="邮箱"
              type="email"
              placeholder="your@email.com"
              value={email}
              onValueChange={setEmail}
              autoComplete="email"
              variant="bordered"
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
              isRequired
            />
            <Input
              label="密码"
              placeholder="至少 6 位"
              value={password}
              onValueChange={setPassword}
              type={showPwd ? "text" : "password"}
              autoComplete="new-password"
              variant="bordered"
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
              endContent={
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="text-gray-400 hover:text-gray-600">
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
              isRequired
            />
            <Input
              label="确认密码"
              placeholder="再次输入密码"
              value={confirm}
              onValueChange={setConfirm}
              type={showPwd ? "text" : "password"}
              autoComplete="new-password"
              variant="bordered"
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
              isRequired
            />

            {error && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg p-2.5">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" color="primary" className="w-full font-medium" size="lg" isLoading={loading}>
              {inviteRequired ? "邀请码注册" : "注册并开始试用"}
            </Button>
          </form>
          <div className="text-center text-sm text-gray-500">
            已有账号？
            <Link href="/login" className="text-primary hover:underline ml-1">登录</Link>
          </div>
        </div>

        <p className="text-center text-xs text-gray-300 mt-6">Pulse © 2025</p>
      </div>
    </div>
  );
}
