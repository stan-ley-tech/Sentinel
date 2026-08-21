"""Pydantic request/response models for the Sentinel Admin API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class RoleIn(BaseModel):
    name: str
    permissions: list[str] = Field(default_factory=list)


class RoleOut(BaseModel):
    name: str
    permissions: list[str]


class ApiKeyIn(BaseModel):
    name: str
    role: str
    rate_limit_per_second: float | None = None
    rate_limit_burst: int | None = None
    quota_limit: int | None = None
    quota_period: str | None = None  # 'day' | 'month'


class ApiKeyUpdate(BaseModel):
    enabled: bool | None = None
    rate_limit_per_second: float | None = None
    rate_limit_burst: int | None = None
    quota_limit: int | None = None
    quota_period: str | None = None


class ApiKeyOut(BaseModel):
    id: str
    name: str
    role: str
    enabled: bool
    rate_limit_per_second: float | None
    rate_limit_burst: int | None
    quota_limit: int | None
    quota_period: str | None
    created_at: str


class ApiKeyCreated(ApiKeyOut):
    key: str
    signing_secret: str


class RouteIn(BaseModel):
    path_prefix: str
    upstreams: list[str]
    strip_prefix: bool = False
    auth_required: bool = True
    required_permission: str | None = None
    require_signature: bool = False


class RouteOut(RouteIn):
    id: str
    created_at: str


class IpRuleIn(BaseModel):
    cidr: str
    action: str  # 'allow' | 'deny'
    priority: int = 0


class IpRuleOut(IpRuleIn):
    id: str
    created_at: str
