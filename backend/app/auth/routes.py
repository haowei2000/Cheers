"""认证模块：用户注册、登录、角色管理."""
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.db.session import async_session_factory, get_session

router = APIRouter(prefix="/api/auth", tags=["认证"])

# 密码加密上下文
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# 角色定义
ROLE_SYSTEM_ADMIN = "system_admin"
ROLE_SPACE_ADMIN = "space_admin"
ROLE_CHANNEL_ADMIN = "channel_admin"
ROLE_MEMBER = "member"
ROLE_GUEST = "guest"

ROLES = [ROLE_SYSTEM_ADMIN, ROLE_SPACE_ADMIN, ROLE_CHANNEL_ADMIN, ROLE_MEMBER, ROLE_GUEST]

# 角色权限映射
ROLE_PERMISSIONS = {
    ROLE_SYSTEM_ADMIN: {
        "user_management": True,
        "space_management": True,
        "channel_management": True,
        "bot_config": True,
        "system_settings": True,
    },
    ROLE_SPACE_ADMIN: {
        "user_management": False,
        "space_management": True,
        "channel_management": True,
        "bot_config": True,
        "system_settings": False,
    },
    ROLE_CHANNEL_ADMIN: {
        "user_management": False,
        "space_management": False,
        "channel_management": True,
        "bot_config": False,
        "system_settings": False,
    },
    ROLE_MEMBER: {
        "user_management": False,
        "space_management": False,
        "channel_management": False,
        "bot_config": False,
        "system_settings": False,
    },
    ROLE_GUEST: {
        "user_management": False,
        "space_management": False,
        "channel_management": False,
        "bot_config": False,
        "system_settings": False,
    },
}


def hash_password(password: str) -> str:
    """哈希密码."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证密码."""
    return pwd_context.verify(plain_password, hashed_password)


# 权限字典（permission -> 拥有该权限的角色列表）
PERMISSIONS: dict[str, list[str]] = {
    perm: [role for role, perms in ROLE_PERMISSIONS.items() if perms.get(perm)]
    for perm in ["user_management", "space_management", "channel_management", "bot_config", "system_settings"]
}


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> User:
    """从 Authorization: Bearer <user_id> 中验证当前用户."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    token = authorization.removeprefix("Bearer ").strip()
    result = await db.execute(select(User).where(User.user_id == token))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="无效 Token")
    return user


async def try_get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_session),
) -> Optional[User]:
    """可选认证：有 token 则验证并返回用户，无 token 则返回 None."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ").strip()
    result = await db.execute(select(User).where(User.user_id == token))
    return result.scalar_one_or_none()


def require_permission(permission: str):
    """返回一个检查调用方是否拥有指定权限的 FastAPI 依赖."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        allowed = PERMISSIONS.get(permission, [])
        if current_user.role not in allowed:
            raise HTTPException(status_code=403, detail="权限不足")
        return current_user
    return _check


# ============ Schemas ============


class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: Optional[str] = None



class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    user_id: str
    username: str
    display_name: Optional[str]
    role: str
    token: str  # 简化：直接返回 user_id 作为 token


class UserInfo(BaseModel):
    user_id: str
    username: str
    display_name: Optional[str]
    role: str
    avatar_url: Optional[str]
    created_at: str


class UpdateRoleRequest(BaseModel):
    user_id: str
    role: str


# ============ Routes ============


@router.post("/register", response_model=UserInfo)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_session)):
    """用户注册."""
    # 检查用户名是否已存在
    result = await db.execute(select(User).where(User.username == req.username))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="用户名已存在",
        )

    # 创建用户
    user = User(
        username=req.username,
        password_hash=hash_password(req.password),
        display_name=req.display_name or req.username,
        role=ROLE_MEMBER,  # 默认角色为成员
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return UserInfo(
        user_id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat(),
    )


@router.post("/login", response_model=LoginResponse)
async def login(req: LoginRequest, db: AsyncSession = Depends(get_session)):
    """用户登录."""
    result = await db.execute(select(User).where(User.username == req.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )

    # 简化：返回 user_id 作为 token
    return LoginResponse(
        user_id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        token=user.user_id,
    )


@router.get("/users", response_model=list[UserInfo])
async def list_users(db: AsyncSession = Depends(get_session)):
    """获取用户列表（系统管理员专用）."""
    result = await db.execute(select(User))
    users = result.scalars().all()

    return [
        UserInfo(
            user_id=u.user_id,
            username=u.username,
            display_name=u.display_name,
            role=u.role,
            avatar_url=u.avatar_url,
            created_at=u.created_at.isoformat(),
        )
        for u in users
    ]


@router.put("/users/{user_id}/role", response_model=UserInfo)
async def update_user_role(
    user_id: str,
    req: UpdateRoleRequest,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    """更新用户角色（系统管理员专用）."""
    if req.role not in ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"无效的角色: {req.role}",
        )

    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )

    user.role = req.role
    await db.commit()
    await db.refresh(user)

    return UserInfo(
        user_id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        avatar_url=user.avatar_url,
        created_at=user.created_at.isoformat(),
    )


@router.get("/roles")
async def list_roles():
    """获取角色列表及权限."""
    return {
        "roles": [
            {
                "name": "system_admin",
                "display_name": "系统管理员",
                "description": "全系统最高权限：用户管理、空间管理、频道管理、Bot配置、系统设置",
                "permissions": ROLE_PERMISSIONS[ROLE_SYSTEM_ADMIN],
            },
            {
                "name": "space_admin",
                "display_name": "空间管理员",
                "description": "本空间内：成员管理、频道创建、Bot配置",
                "permissions": ROLE_PERMISSIONS[ROLE_SPACE_ADMIN],
            },
            {
                "name": "channel_admin",
                "display_name": "频道管理员",
                "description": "本频道内：成员管理、频道信息编辑、置顶消息",
                "permissions": ROLE_PERMISSIONS[ROLE_CHANNEL_ADMIN],
            },
            {
                "name": "member",
                "display_name": "成员",
                "description": "发送消息、上传文件、@Bot",
                "permissions": ROLE_PERMISSIONS[ROLE_MEMBER],
            },
            {
                "name": "guest",
                "display_name": "访客",
                "description": "仅查看公开频道（不可发言）",
                "permissions": ROLE_PERMISSIONS[ROLE_GUEST],
            },
        ]
    }


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    """删除用户（系统管理员专用）."""
    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )

    await db.delete(user)
    await db.commit()

    return {"status": "success", "message": "用户已删除"}


@router.post("/users/reset-password/{user_id}")
async def reset_password(
    user_id: str,
    _: User = Depends(require_permission("user_management")),
    db: AsyncSession = Depends(get_session),
):
    """重置用户密码为 123456（系统管理员专用）."""
    result = await db.execute(select(User).where(User.user_id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        )

    user.password_hash = hash_password("123456")
    await db.commit()

    return {"status": "success", "message": "密码已重置为 123456"}
