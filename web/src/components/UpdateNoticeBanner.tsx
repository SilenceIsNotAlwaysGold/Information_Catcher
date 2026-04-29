"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { Card, CardBody, Button, Chip } from "@nextui-org/react";

// 改版本号即可让所有用户重新看到一次新公告。
const NOTICE_ID = "2026-04-yqmm-launch";

export function UpdateNoticeBanner() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const seen = typeof window !== "undefined"
      ? window.localStorage.getItem(`notice:${NOTICE_ID}`)
      : null;
    setDismissed(!!seen);
  }, []);

  const close = () => {
    window.localStorage.setItem(`notice:${NOTICE_ID}`, "1");
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <Card className="border border-primary/30 bg-gradient-to-r from-primary/5 to-pink-50">
      <CardBody className="py-4 px-5">
        <div className="flex items-start gap-3">
          <div className="text-primary mt-0.5">
            <Sparkles size={18} />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">系统升级公告</span>
              <Chip size="sm" color="primary" variant="flat">v2.0</Chip>
              <span className="text-xs text-default-400 ml-auto">2026-04-28</span>
            </div>
            <p className="text-sm text-default-600">
              本次升级我们把系统改造成了支持多用户的 SaaS 平台。你之前积累的全部监控帖子、告警和数据都已平滑迁移，<b>无需重新配置</b>。
            </p>
            <ul className="text-sm text-default-700 space-y-1">
              <li>· <b>账号系统上线</b>：你的账号是 <code className="bg-default-100 px-1 rounded">yqmm</code>，登录后看到的就是元气满满的私有数据，未来同事也能各自注册独立使用</li>
              <li>· <b>不再消耗你的小红书号</b>：观测帖子、详情抓取、图片视频全部走匿名通道；只有热门搜索仍用平台维护的共享账号</li>
              <li>· <b>失效帖子自动隔离</b>：连续抓取失败 5 次以上的帖子会被自动标记停抓，列表顶部出现「清理失效」按钮一键清掉，避免持续打无效请求</li>
              <li>· <b>更安全的密钥管理</b>：AI Key、飞书应用密钥等敏感配置由管理员统一维护，普通用户看不到也碰不到</li>
              <li>· <b>新增热门内容封面/图集/视频预览</b>，列表里直接看图，点开看大图</li>
            </ul>
            <p className="text-xs text-default-400 pt-1">
              使用过程中有任何问题或新需求随时反馈。
            </p>
          </div>
          <Button isIconOnly size="sm" variant="light" onPress={close} aria-label="关闭公告">
            <X size={16} />
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
