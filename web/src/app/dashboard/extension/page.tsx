"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Button } from "@nextui-org/button";
import { Chip } from "@nextui-org/chip";
import { Snippet } from "@nextui-org/snippet";
import { Divider } from "@nextui-org/divider";
import { Code } from "@nextui-org/code";
import { Input } from "@nextui-org/input";
import { Spinner } from "@nextui-org/spinner";
import { Select, SelectItem } from "@nextui-org/select";
import { Puzzle, CheckCircle2, XCircle, Search, Download } from "lucide-react";
import toast from "react-hot-toast";
import { PageHeader } from "@/components/ui";
import { useApi } from "@/lib/useApi";

type ExtStatus = {
  online_count: number;
  instances: Array<{ ua: string; ext_version: string; joined_at: number }>;
};

export default function ExtensionPage() {
  const [token, setToken] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [platform, setPlatform] = useState<"xhs" | "douyin">("xhs");
  const [keyword, setKeyword] = useState("淘宝好物");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<any>(null);

  // 用 SWR 拉扩展状态（每 5 秒刷新）
  const { data: status, mutate: refreshStatus } = useApi<ExtStatus>(
    "/api/extension/status",
    { refreshInterval: 5000 },
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    setToken(localStorage.getItem("token") || "");
    // 服务器地址：如果当前页面是 https/http 域名，那扩展应该填同样的地址
    const origin = window.location.origin.replace(/\/$/, "");
    setServerUrl(origin);
  }, []);

  const online = status?.online_count ?? 0;

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} 已复制`),
      () => toast.error("复制失败，请手动选中"),
    );
  };

  const runSearch = async () => {
    if (!keyword.trim()) {
      toast.error("请输入关键词");
      return;
    }
    if (online === 0) {
      toast.error("没有在线扩展，请先安装并连接");
      return;
    }
    setSearching(true);
    setSearchResult(null);
    try {
      const tk = localStorage.getItem("token") || "";
      const endpoint = platform === "douyin" ? "/api/extension/run_douyin_search" : "/api/extension/run_xhs_search";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tk}`,
        },
        body: JSON.stringify({
          keyword: keyword.trim(),
          min_likes: 100,
          timeout_ms: 30000,
          pages: 2,
          timeout: 90,
        }),
      });
      const res = await r.json();
      setSearchResult(res);
      if (res.ok) {
        toast.success(`抓到 ${res.captured} 条，新增 ${res.inserted} 条`);
      } else {
        toast.error(res.error || "搜索失败");
      }
    } catch (e: any) {
      toast.error(e?.message || "请求失败");
      setSearchResult({ ok: false, error: e?.message });
    } finally {
      setSearching(false);
      refreshStatus();
    }
  };

  const installSteps = useMemo(
    () => [
      <>从 <a className="text-primary underline" href="/extension.zip" download>下载扩展压缩包</a> 并解压（或直接使用项目中的 <Code className="text-tiny">extension/</Code> 目录）</>,
      <>Chrome / Edge 浏览器地址栏输入 <Code>chrome://extensions</Code></>,
      <>右上角打开「开发者模式」</>,
      <>左上角点「加载已解压的扩展程序」，选择刚才解压的 <Code>extension/</Code> 目录</>,
      <>扩展栏出现 TrendPulse Helper 图标，点开 popup</>,
      <>把下面的「服务器地址」和「Token」复制进去，点「保存并连接」</>,
      <>看到状态点变绿即握手成功，本页右上角的「在线扩展数」也会变成 1+</>,
      <>另开一个浏览器标签登录小红书账号 → 回到本页用下面的「测试搜索」验证</>,
    ],
    [],
  );

  return (
    <div className="p-6 space-y-6 max-w-page mx-auto">
      <PageHeader
        section="toolbox"
        icon={Puzzle}
        title="浏览器扩展"
        hint="TrendPulse Helper —— 从浏览器抓帖子、博主主页、热门关键词。"
      />
      {/* 顶部状态卡片 */}
      <Card>
        <CardHeader className="flex justify-between items-center pb-2">
          <div className="flex items-center gap-2">
            <Puzzle className="text-primary" size={20} />
            <span className="font-semibold">扩展运行状态</span>
          </div>
          {online > 0 ? (
            <Chip color="success" startContent={<CheckCircle2 size={14} />} variant="flat">
              {online} 个浏览器在线
            </Chip>
          ) : (
            <Chip color="default" startContent={<XCircle size={14} />} variant="flat">
              无在线扩展
            </Chip>
          )}
        </CardHeader>
        <CardBody className="text-sm text-default-600 pt-0">
          扩展跑在你自己的浏览器里，使用你已登录的小红书 / 抖音 cookie 执行搜索任务，
          <strong className="text-default-900">规避封号风险</strong>。
          浏览器关闭时任务会暂停，下次打开自动恢复。
        </CardBody>
      </Card>

      {/* 配置信息 */}
      <Card>
        <CardHeader className="pb-2">
          <span className="font-semibold">扩展配置（在 popup 里填这两项）</span>
        </CardHeader>
        <CardBody className="space-y-3 pt-0 text-sm">
          <div>
            <div className="text-tiny text-default-500 mb-1">服务器地址</div>
            <Snippet symbol="" color="default" variant="bordered" classNames={{ base: "w-full", pre: "truncate" }} onCopy={() => toast.success("服务器地址已复制")}>
              {serverUrl}
            </Snippet>
          </div>
          <div>
            <div className="text-tiny text-default-500 mb-1">
              Token（一长串 base64.hash 格式，登录有效期 12 小时）
            </div>
            <Snippet symbol="" color="default" variant="bordered" classNames={{ base: "w-full", pre: "truncate font-mono text-tiny" }} onCopy={() => toast.success("Token 已复制")}>
              {token || "(未登录)"}
            </Snippet>
            <div className="text-tiny text-default-400 mt-1">
              点 token 右边的复制按钮即可。Token 过期后回本页重新刷新即可拿到新的。
            </div>
          </div>
        </CardBody>
      </Card>

      {/* 安装指南 */}
      <Card>
        <CardHeader className="pb-2">
          <span className="font-semibold">安装步骤（首次使用）</span>
        </CardHeader>
        <CardBody className="pt-0 text-sm">
          <ol className="space-y-2 list-decimal pl-5 text-default-700">
            {installSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <div className="mt-3 text-tiny text-default-500">
            ⚠️ Chrome 版本需 ≥ 111（支持 Manifest V3 main world content scripts）。
          </div>
        </CardBody>
      </Card>

      {/* 测试搜索 */}
      <Card>
        <CardHeader className="pb-2">
          <span className="font-semibold">测试搜索（端到端验证）</span>
        </CardHeader>
        <CardBody className="space-y-3 pt-0">
          <div className="flex gap-2 items-end">
            <Select
              label="平台"
              size="sm"
              selectedKeys={[platform]}
              onChange={(e) => setPlatform((e.target.value as "xhs" | "douyin") || "xhs")}
              className="w-32"
            >
              <SelectItem key="xhs" value="xhs">小红书</SelectItem>
              <SelectItem key="douyin" value="douyin">抖音</SelectItem>
            </Select>
            <Input
              label="关键词"
              size="sm"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="flex-1"
            />
            <Button
              color="primary"
              startContent={searching ? <Spinner size="sm" color="white" /> : <Search size={16} />}
              isDisabled={online === 0 || searching}
              onClick={runSearch}
            >
              {searching ? "搜索中..." : "立即搜索"}
            </Button>
          </div>
          <div className="text-tiny text-default-500">
            ⚠️ 测试前确保浏览器已经登录对应平台（{platform === "xhs" ? "xiaohongshu.com" : "douyin.com"}），否则结果为空
          </div>
          {online === 0 && (
            <div className="text-tiny text-warning">
              先安装扩展并连接成功，本页右上角显示在线扩展数 ≥ 1 后才能搜索
            </div>
          )}
          {searchResult && (
            <div>
              <Divider className="my-2" />
              <div className="text-tiny mb-2">
                {searchResult.ok ? (
                  <span className="text-success">
                    ✅ 抓到 {searchResult.captured} 条 · 新增 {searchResult.inserted} · 更新 {searchResult.updated}
                  </span>
                ) : (
                  <span className="text-danger">❌ {searchResult.error || "失败"}</span>
                )}
              </div>
              <Code className="block whitespace-pre text-tiny max-h-60 overflow-auto">
                {JSON.stringify(searchResult, null, 2)}
              </Code>
              {searchResult.ok && searchResult.captured > 0 && (
                <div className="mt-2 text-tiny">
                  → 进 <a className="text-primary underline" href="/dashboard/xhs/trending">小红书 / 热门</a> 看新入库的笔记
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* 排错 */}
      <Card>
        <CardHeader className="pb-2">
          <span className="font-semibold text-default-700">排错速查</span>
        </CardHeader>
        <CardBody className="pt-0 text-sm space-y-2 text-default-600">
          <div><strong>状态点是灰 / 红：</strong> 服务器地址末尾是否带了 <Code>/</Code>？token 是否最新？看扩展 service worker 控制台 <Code>chrome://extensions → TrendPulse Helper → Service Worker</Code></div>
          <div><strong>captured 为 0：</strong> 浏览器没登录小红书，或者搜索 API 路径变了。先在浏览器手动打开 <Code>https://www.xiaohongshu.com/search_result?keyword=test</Code> 看看能否正常出搜索结果</div>
          <div><strong>503 no online extension：</strong> popup 状态点是绿才会被注册到调度池</div>
        </CardBody>
      </Card>
    </div>
  );
}
