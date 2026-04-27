"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input, Button } from "@nextui-org/react";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { login, isAuthenticated, isLoading: authLoading } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && isAuthenticated) router.replace("/dashboard");
  }, [isAuthenticated, authLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username || !password) { setError("请输入账号和密码"); return; }
    setLoading(true);
    try {
      await login({ username, password });
      router.push("/dashboard");
    } catch {
      setError("账号或密码错误");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f9fafb] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-primary mb-4 shadow-lg shadow-primary/30">
            <span className="text-white font-bold text-xl">P</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Pulse</h1>
          <p className="text-sm text-gray-400 mt-1">帖子数据监控平台</p>
        </div>

        {/* Form */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="账号"
              placeholder="请输入账号"
              value={username}
              onValueChange={setUsername}
              autoComplete="username"
              variant="bordered"
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
            />
            <Input
              label="密码"
              placeholder="请输入密码"
              value={password}
              onValueChange={setPassword}
              type={showPwd ? "text" : "password"}
              autoComplete="current-password"
              variant="bordered"
              classNames={{ label: "text-gray-500", inputWrapper: "border-gray-200" }}
              endContent={
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="text-gray-400 hover:text-gray-600">
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
            />

            {error && <p className="text-sm text-danger text-center">{error}</p>}

            <Button type="submit" color="primary" className="w-full font-medium" size="lg" isLoading={loading}>
              登录
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-300 mt-6">Pulse © 2025</p>
      </div>
    </div>
  );
}
