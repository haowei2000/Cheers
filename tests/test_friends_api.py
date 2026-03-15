"""好友管理 API 测试."""
import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_add_friend_by_username(client: AsyncClient, db_session):
    """测试通过用户名添加好友."""
    # 创建两个用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "user1",
        "password": "password123",
        "display_name": "User One"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    user2_res = await client.post("/api/auth/register", json={
        "username": "user2",
        "password": "password123",
        "display_name": "User Two"
    })
    assert user2_res.status_code == 200
    
    # 通过用户名添加好友
    res = await client.post("/api/friends", json={
        "user_id": user1_id,
        "friend_identifier": "user2"
    })
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    assert res.json()["data"]["username"] == "user2"


@pytest.mark.asyncio
async def test_add_friend_by_user_id(client: AsyncClient, db_session):
    """测试通过用户ID添加好友."""
    # 创建两个用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "user3",
        "password": "password123",
        "display_name": "User Three"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    user2_res = await client.post("/api/auth/register", json={
        "username": "user4",
        "password": "password123",
        "display_name": "User Four"
    })
    assert user2_res.status_code == 200
    user2_id = user2_res.json()["user_id"]
    
    # 通过用户ID添加好友
    res = await client.post("/api/friends", json={
        "user_id": user1_id,
        "friend_identifier": user2_id
    })
    assert res.status_code == 200
    assert res.json()["status"] == "success"


@pytest.mark.asyncio
async def test_list_friends(client: AsyncClient, db_session):
    """测试获取好友列表."""
    # 创建用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "user5",
        "password": "password123",
        "display_name": "User Five"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    user2_res = await client.post("/api/auth/register", json={
        "username": "user6",
        "password": "password123",
        "display_name": "User Six"
    })
    assert user2_res.status_code == 200
    user2_id = user2_res.json()["user_id"]
    
    # 添加好友
    await client.post("/api/friends", json={
        "user_id": user1_id,
        "friend_identifier": user2_id
    })
    
    # 获取好友列表
    res = await client.get(f"/api/friends/{user1_id}")
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    friends = res.json()["data"]
    assert len(friends) == 1
    assert friends[0]["user_id"] == user2_id


@pytest.mark.asyncio
async def test_remove_friend(client: AsyncClient, db_session):
    """测试删除好友."""
    # 创建用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "user7",
        "password": "password123",
        "display_name": "User Seven"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    user2_res = await client.post("/api/auth/register", json={
        "username": "user8",
        "password": "password123",
        "display_name": "User Eight"
    })
    assert user2_res.status_code == 200
    user2_id = user2_res.json()["user_id"]
    
    # 添加好友
    await client.post("/api/friends", json={
        "user_id": user1_id,
        "friend_identifier": user2_id
    })
    
    # 删除好友
    res = await client.request("DELETE", "/api/friends", json={
        "user_id": user1_id,
        "friend_id": user2_id
    })
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    
    # 验证好友已删除
    list_res = await client.get(f"/api/friends/{user1_id}")
    assert len(list_res.json()["data"]) == 0


@pytest.mark.asyncio
async def test_search_users(client: AsyncClient, db_session):
    """测试搜索用户."""
    # 创建用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "testsearch",
        "password": "password123",
        "display_name": "Test Search User"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    # 搜索用户
    res = await client.get(f"/api/friends/search?query=testsearch&current_user_id={user1_id}")
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    results = res.json()["data"]
    # 搜索应该返回匹配的用户（排除自己）
    assert len(results) == 0  # 因为自己被排除了


@pytest.mark.asyncio
async def test_cannot_add_self_as_friend(client: AsyncClient, db_session):
    """测试不能添加自己为好友."""
    # 创建用户
    res = await client.post("/api/auth/register", json={
        "username": "selfuser",
        "password": "password123",
        "display_name": "Self User"
    })
    assert res.status_code == 200
    user_id = res.json()["user_id"]
    
    # 尝试添加自己
    add_res = await client.post("/api/friends", json={
        "user_id": user_id,
        "friend_identifier": user_id
    })
    assert add_res.status_code == 400
    assert "不能添加自己" in add_res.json()["detail"]


@pytest.mark.asyncio
async def test_invite_member_by_identifier(client: AsyncClient, db_session):
    """测试通过用户名/ID邀请用户加入频道."""
    # 创建工作空间
    ws_res = await client.post("/api/workspaces", json={"name": "Test Workspace"})
    assert ws_res.status_code == 200
    ws_id = ws_res.json()["data"]["workspace_id"]
    
    # 创建频道
    ch_res = await client.post("/api/channels", json={
        "workspace_id": ws_id,
        "name": "test-channel",
        "type": "public"
    })
    assert ch_res.status_code == 200
    ch_id = ch_res.json()["data"]["channel_id"]
    
    # 创建用户
    user1_res = await client.post("/api/auth/register", json={
        "username": "inviter",
        "password": "password123",
        "display_name": "Inviter"
    })
    assert user1_res.status_code == 200
    user1_id = user1_res.json()["user_id"]
    
    user2_res = await client.post("/api/auth/register", json={
        "username": "invitee",
        "password": "password123",
        "display_name": "Invitee"
    })
    assert user2_res.status_code == 200
    
    # 通过用户名邀请
    invite_res = await client.post(f"/api/channels/{ch_id}/invite", json={
        "inviter_id": user1_id,
        "identifier": "invitee"
    })
    assert invite_res.status_code == 200
    assert invite_res.json()["status"] == "success"
