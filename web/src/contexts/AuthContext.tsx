// 认证Context - 管理用户登录状态
"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { mutate as swrMutate } from 'swr';
import { User, LoginRequest } from '@/types';
import { authApi } from '@/lib/api';

// 与 useApi.ts 中 useMe 的 SWR key 形状必须一致
const ME_KEY = (token: string) => ['/api/auth/me', token] as const;
const seedMe = (token: string, user: User) =>
  swrMutate(ME_KEY(token), user, { revalidate: false });

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  setToken: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // 从localStorage恢复登录状态
    const savedToken = localStorage.getItem('token');
    if (savedToken) {
      setToken(savedToken);
      // 验证token并获取用户信息
      authApi.getCurrentUser(savedToken)
        .then((userData) => {
          setUser(userData);
          seedMe(savedToken, userData);
        })
        .catch(() => {
          // token无效，清除
          localStorage.removeItem('token');
          setToken(null);
        })
        .finally(() => {
          setIsLoading(false);
        });
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = async (credentials: LoginRequest) => {
    const response = await authApi.login(credentials);
    setToken(response.access_token);
    setUser(response.user);
    localStorage.setItem('token', response.access_token);
    seedMe(response.access_token, response.user);
  };

  const register = async (email: string, password: string) => {
    const r = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "注册失败");
    setToken(data.access_token);
    localStorage.setItem("token", data.access_token);
    // 立刻拉取用户信息
    try {
      const userData = await authApi.getCurrentUser(data.access_token);
      setUser(userData);
      seedMe(data.access_token, userData);
    } catch {
      // 忽略，下次刷新会重新拉
    }
  };

  const updateToken = (newToken: string) => {
    setToken(newToken);
    localStorage.setItem("token", newToken);
    authApi.getCurrentUser(newToken)
      .then((u) => { setUser(u); seedMe(newToken, u); })
      .catch(() => {});
  };

  const logout = () => {
    if (token) {
      authApi.logout(token).catch(console.error);
    }
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!token && !!user,
        isLoading,
        login,
        register,
        setToken: updateToken,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
