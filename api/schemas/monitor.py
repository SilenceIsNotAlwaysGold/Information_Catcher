from typing import List, Optional
from pydantic import BaseModel, ConfigDict, Field


class AddPostsRequest(BaseModel):
    links: List[str]
    account_id: Optional[int] = None
    post_type: str = "observe"  # legacy, kept for compat
    group_id: Optional[int] = None  # 推荐用 group_id 替代 post_type


class UpdatePostRequest(BaseModel):
    group_id: Optional[int] = None


class CreateGroupRequest(BaseModel):
    name: str


class UpdateGroupRequest(BaseModel):
    name: Optional[str] = None
    feishu_webhook_url: Optional[str] = None
    wecom_webhook_url: Optional[str] = None
    likes_alert_enabled: Optional[bool] = None
    likes_threshold: Optional[int] = None
    collects_alert_enabled: Optional[bool] = None
    collects_threshold: Optional[int] = None
    comments_alert_enabled: Optional[bool] = None
    comments_threshold: Optional[int] = None
    message_prefix: Optional[str] = None
    template_likes: Optional[str] = None
    template_collects: Optional[str] = None
    template_comments: Optional[str] = None
    alert_rules: Optional[str] = None  # JSON array string


class CreatePromptRequest(BaseModel):
    name: str
    content: str


class UpdatePromptRequest(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None


class RewriteTrendingRequest(BaseModel):
    prompt_id: Optional[int] = None  # use saved prompt by ID (preferred)
    prompt_text: Optional[str] = None  # or supply ad-hoc prompt text


class RewriteCrossPlatformRequest(BaseModel):
    """跨平台改写：优先级 prompt_text > prompt_id > target 内置模板。"""
    prompt_id: Optional[int] = None
    prompt_text: Optional[str] = None
    target: Optional[str] = None  # xhs / douyin / mp，回退用
    variants: Optional[int] = 3


class LockVariantRequest(BaseModel):
    variant: str


class AddCreatorRequest(BaseModel):
    creator_url: str
    creator_name: Optional[str] = ""
    platform: Optional[str] = None  # 不填自动从 URL 识别


class AddLiveRequest(BaseModel):
    room_url: str
    streamer_name: Optional[str] = ""
    online_alert_threshold: Optional[int] = 0
    platform: Optional[str] = "douyin"


class SyncBitableRequest(BaseModel):
    note_ids: List[str]


class DeletePostRequest(BaseModel):
    note_id: str


class AddAccountRequest(BaseModel):
    name: str
    cookie: str
    proxy_url: Optional[str] = ""
    user_agent: Optional[str] = ""
    viewport: Optional[str] = ""
    timezone: Optional[str] = "Asia/Shanghai"
    locale: Optional[str] = "zh-CN"
    fp_browser_type: Optional[str] = "builtin"  # builtin | adspower | bitbrowser
    fp_profile_id: Optional[str] = ""
    fp_api_url: Optional[str] = ""
    # 仅 admin 可设：勾选后该账号进入平台共享池，被所有用户的任务复用
    is_shared: Optional[bool] = False
    # 平台标识：xhs / douyin / mp（默认 xhs）
    platform: Optional[str] = "xhs"


class QRLoginStartRequest(BaseModel):
    """Account template applied when the login succeeds."""
    name: str = ""
    proxy_url: Optional[str] = ""
    user_agent: Optional[str] = ""
    viewport: Optional[str] = ""
    timezone: Optional[str] = "Asia/Shanghai"
    locale: Optional[str] = "zh-CN"
    platform: Optional[str] = "xhs"  # xhs / douyin（v1 仅 xhs 实现）


class UpdateAccountRequest(BaseModel):
    name: Optional[str] = None
    cookie: Optional[str] = None
    proxy_url: Optional[str] = None
    user_agent: Optional[str] = None
    viewport: Optional[str] = None
    timezone: Optional[str] = None
    locale: Optional[str] = None
    fp_browser_type: Optional[str] = None
    fp_profile_id: Optional[str] = None
    fp_api_url: Optional[str] = None
    is_shared: Optional[bool] = None


class UpdateSettingsRequest(BaseModel):
    # 允许 extra：用于平台前缀覆盖键，例如 "xhs.likes_threshold"、"douyin.collects_alert_enabled"
    # 这些 key 由 router 端做白名单校验后写入 monitor_settings（key-value 表）
    model_config = ConfigDict(extra="allow")

    webhook_url: Optional[str] = None
    feishu_webhook_url: Optional[str] = None
    check_interval_minutes: Optional[int] = Field(default=None, ge=1)
    daily_report_enabled: Optional[bool] = None
    daily_report_time: Optional[str] = None
    likes_alert_enabled: Optional[bool] = None
    likes_threshold: Optional[int] = Field(default=None, ge=1)
    collects_alert_enabled: Optional[bool] = None
    collects_threshold: Optional[int] = Field(default=None, ge=1)
    comments_alert_enabled: Optional[bool] = None
    comments_threshold: Optional[int] = Field(default=None, ge=1)
    ai_base_url: Optional[str] = None
    ai_api_key: Optional[str] = None
    ai_model: Optional[str] = None
    ai_rewrite_enabled: Optional[bool] = None
    ai_rewrite_prompt: Optional[str] = None
    feishu_app_id: Optional[str] = None
    feishu_app_secret: Optional[str] = None
    feishu_oauth_redirect_uri: Optional[str] = None
    feishu_bitable_root_folder_token: Optional[str] = None
    feishu_admin_open_id: Optional[str] = None
    feishu_invite_url: Optional[str] = None
    feishu_bitable_app_token: Optional[str] = None
    feishu_bitable_table_id: Optional[str] = None
    feishu_bitable_image_table_id: Optional[str] = None
    qiniu_access_key: Optional[str] = None
    qiniu_secret_key: Optional[str] = None
    qiniu_bucket: Optional[str] = None
    qiniu_domain: Optional[str] = None
    public_url_prefix: Optional[str] = None
    trending_enabled: Optional[bool] = None
    trending_keywords: Optional[str] = None
    trending_min_likes: Optional[int] = None
    trending_account_ids: Optional[str] = None
    comments_fetch_enabled: Optional[bool] = None
    newrank_api_key: Optional[str] = None
    newrank_api_base: Optional[str] = None
