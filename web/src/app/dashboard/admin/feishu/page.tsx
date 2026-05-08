"use client";

/**
 * /dashboard/admin/feishu —— 飞书应用 & OAuth admin 配置
 *
 * 包含：
 *   - 应用 App ID / Secret（创建在飞书开放平台）
 *   - OAuth 回调地址（要跟开放平台的「重定向 URL 白名单」一致）
 *   - 多维表格根文件夹 token（所有用户的专属 bitable 都建在这下面）
 *   - admin open_id（admin 绑定后自动写入，用于把 admin 拉进所有用户群）
 *   - 企业邀请链接（自建应用要求外部用户先扫码加入企业）
 */
import { useState, useEffect } from "react";
import { Card, CardBody, CardHeader } from "@nextui-org/card";
import { Input } from "@nextui-org/input";
import { Button } from "@nextui-org/button";
import { Save, LinkIcon, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useMe } from "@/lib/useApi";
import { useAdminSettings } from "@/lib/useAdminSettings";

export default function AdminFeishuPage() {
  useAuth();
  const { data: me } = useMe();
  const isAdmin = me?.role === "admin";
  const { settings, loading, saving, saveSubset } = useAdminSettings();

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [folderToken, setFolderToken] = useState("");
  const [adminOpenId, setAdminOpenId] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteCode, setInviteCode] = useState("");

  useEffect(() => {
    if (!loading) {
      setAppId(settings.feishu_app_id || "");
      setAppSecret(settings.feishu_app_secret || "");
      setRedirectUri(settings.feishu_oauth_redirect_uri || "");
      setFolderToken(settings.feishu_bitable_root_folder_token || "");
      setAdminOpenId(settings.feishu_admin_open_id || "");
      setInviteUrl(settings.feishu_invite_url || "");
      setInviteCode(settings.feishu_invite_code || "");
    }
  }, [loading, settings]);

  if (!isAdmin && me) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardBody className="flex flex-row gap-2 items-center text-sm text-warning">
            <AlertCircle size={16} /> 仅管理员可访问
          </CardBody>
        </Card>
      </div>
    );
  }

  const handleSave = () =>
    saveSubset({
      feishu_app_id: appId.trim(),
      feishu_app_secret: appSecret.trim(),
      feishu_oauth_redirect_uri: redirectUri.trim(),
      feishu_bitable_root_folder_token: folderToken.trim(),
      feishu_admin_open_id: adminOpenId.trim(),
      feishu_invite_url: inviteUrl.trim(),
      feishu_invite_code: inviteCode.trim().toUpperCase(),
    }, "飞书应用配置已保存");

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <LinkIcon size={22} className="text-primary" />
          飞书应用 & OAuth
        </h1>
        <p className="text-sm text-default-500 mt-1">
          企业自建应用凭据。配置完后用户在「个人设置」可一键扫码绑定，系统自动建群 + 多维表格。
        </p>
      </div>

      <Card>
        <CardHeader className="font-semibold">应用凭据</CardHeader>
        <CardBody className="space-y-4">
          <p className="text-xs text-default-400">
            需在飞书开放平台开通权限：
            <code className="mx-1">im:chat</code>
            <code className="mx-1">im:message:send_as_bot</code>
            <code className="mx-1">bitable:app</code>
            <code className="mx-1">drive:drive</code>
            <code className="mx-1">contact:user.id:readonly</code>
            。改了权限或回调地址后必须发布版本才生效。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="App ID" labelPlacement="outside" placeholder="cli_..."
              value={appId} onValueChange={setAppId} isDisabled={loading} />
            <Input label="App Secret" labelPlacement="outside" placeholder="..."
              type="password" value={appSecret} onValueChange={setAppSecret}
              isDisabled={loading} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">OAuth & 多维表格</CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="OAuth 回调地址"
            labelPlacement="outside"
            placeholder="https://你的域名/api/feishu/oauth/callback"
            value={redirectUri}
            onValueChange={setRedirectUri}
            isDisabled={loading}
            description="必须与飞书开放平台「安全设置 → 重定向 URL」白名单完全一致（含协议、端口）。"
          />
          <Input
            label="多维表格根文件夹 Token"
            labelPlacement="outside"
            placeholder="fldcn..."
            value={folderToken}
            onValueChange={setFolderToken}
            isDisabled={loading}
            description="飞书云空间随便建一个文件夹，URL 末尾的 fldcn... 即是。所有用户的专属表格都建在该文件夹下。"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="font-semibold">外部集成</CardHeader>
        <CardBody className="space-y-4">
          <Input
            label="Admin open_id（自动同步）"
            labelPlacement="outside"
            placeholder="ou_xxxxx"
            value={adminOpenId}
            onValueChange={setAdminOpenId}
            isDisabled={loading}
            description="admin 完成「绑定飞书」后自动写入。普通用户建群时会拉 admin 进群。手改仅用于异常恢复。"
          />
          <Input
            label="企业邀请链接（自建应用必填）"
            labelPlacement="outside"
            placeholder="https://applink.feishu.cn/..."
            value={inviteUrl}
            onValueChange={setInviteUrl}
            isDisabled={loading}
            description="自建应用只允许本企业成员授权。把企业邀请链接贴进来，前端会在「绑定飞书」卡片渲染成二维码引导外部用户先加入企业。"
          />
          <Input
            label="8 位企业邀请码"
            labelPlacement="outside"
            placeholder="如 QRLQYWGV"
            value={inviteCode}
            onValueChange={setInviteCode}
            isDisabled={loading}
            description="飞书邀请短信中「8 位数企业邀请码」（字母组合）。扫码后飞书 App 跳到「输入企业邀请码」页面时需要手动输入；前端会一并展示并提供一键复制。"
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button
          color="primary"
          startContent={<Save size={16} />}
          isLoading={saving}
          onPress={handleSave}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
