"""密钥链 API：用户个人密钥管理。"""
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import get_current_user, get_session
from app.core.schemas import KeychainItemCreate, KeychainItemInResponse, KeychainItemUpdate
from app.db.models import KeychainItem, User
from app.utils.crypto import decrypt_value, encrypt_value

router = APIRouter(prefix="/keychain", tags=["keychain"])


def _mask_value(value: str) -> str:
    """掩码显示密钥值，只显示最后4位。"""
    if not value:
        return "****"
    if len(value) <= 4:
        return "****" + value
    return "****" + value[-4:]


@router.get("/", response_model=List[KeychainItemInResponse])
async def list_keychain_items(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    """获取当前用户的所有密钥项（不包含实际密钥值）。"""
    stmt = select(KeychainItem).where(KeychainItem.owner_id == current_user.user_id)
    result = await db.execute(stmt)
    items = result.scalars().all()

    response_items = []
    for item in items:
        # Decrypt only to produce a masked display value.
        decrypted = decrypt_value(item.value) or ""
        item_dict = {
            "key_id": item.key_id,
            "owner_id": item.owner_id,
            "name": item.name,
            "description": item.description,
            "value_masked": _mask_value(decrypted),
            "created_at": item.created_at,
            "updated_at": item.updated_at,
        }
        response_items.append(KeychainItemInResponse.model_validate(item_dict))

    return response_items


@router.post("/", response_model=KeychainItemInResponse)
async def create_keychain_item(
    item_in: KeychainItemCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    """创建新的密钥项。"""
    # Check whether the name already exists.
    stmt = select(KeychainItem).where(
        KeychainItem.owner_id == current_user.user_id,
        KeychainItem.name == item_in.name
    )
    result = await db.execute(stmt)
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail=f"密钥名称 '{item_in.name}' 已存在")

    # Store the encrypted value.
    encrypted_value = encrypt_value(item_in.value)

    item = KeychainItem(
        owner_id=current_user.user_id,
        name=item_in.name,
        value=encrypted_value,
        description=item_in.description
    )
    db.add(item)
    await db.commit()
    await db.refresh(item)

    return KeychainItemInResponse.model_validate({
        "key_id": item.key_id,
        "owner_id": item.owner_id,
        "name": item.name,
        "description": item.description,
        "value_masked": _mask_value(item_in.value),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    })


@router.get("/{key_id}", response_model=KeychainItemInResponse)
async def get_keychain_item(
    key_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    """获取单个密钥项（不包含实际密钥值）。"""
    item = await db.get(KeychainItem, key_id)
    if not item or item.owner_id != current_user.user_id:
        raise HTTPException(status_code=404, detail="密钥项不存在")

    decrypted = decrypt_value(item.value) or ""
    return KeychainItemInResponse.model_validate({
        "key_id": item.key_id,
        "owner_id": item.owner_id,
        "name": item.name,
        "description": item.description,
        "value_masked": _mask_value(decrypted),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    })


@router.put("/{key_id}", response_model=KeychainItemInResponse)
async def update_keychain_item(
    key_id: str,
    item_in: KeychainItemUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    """更新密钥项。"""
    item = await db.get(KeychainItem, key_id)
    if not item or item.owner_id != current_user.user_id:
        raise HTTPException(status_code=404, detail="密钥项不存在")

    # If the name changes, check for conflicts with other keys.
    if item_in.name is not None and item_in.name != item.name:
        stmt = select(KeychainItem).where(
            KeychainItem.owner_id == current_user.user_id,
            KeychainItem.name == item_in.name
        )
        result = await db.execute(stmt)
        if result.scalar_one_or_none():
            raise HTTPException(status_code=400, detail=f"密钥名称 '{item_in.name}' 已存在")
        item.name = item_in.name

    if item_in.value is not None:
        item.value = encrypt_value(item_in.value)

    if item_in.description is not None:
        item.description = item_in.description

    item.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(item)

    decrypted = decrypt_value(item.value) or ""
    return KeychainItemInResponse.model_validate({
        "key_id": item.key_id,
        "owner_id": item.owner_id,
        "name": item.name,
        "description": item.description,
        "value_masked": _mask_value(decrypted),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    })


@router.delete("/{key_id}")
async def delete_keychain_item(
    key_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_session)
):
    """删除密钥项。"""
    item = await db.get(KeychainItem, key_id)
    if not item or item.owner_id != current_user.user_id:
        raise HTTPException(status_code=404, detail="密钥项不存在")

    await db.delete(item)
    await db.commit()
    return {"detail": "ok"}
