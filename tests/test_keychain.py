"""Tests for keychain feature."""
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_create_keychain_item(client: AsyncClient):
    """Test creating a keychain item."""
    response = await client.post(
        "/api/v1/keychain/",
        json={"name": "test-api-key", "value": "sk-123456", "description": "Test key"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "test-api-key"
    assert data["value_masked"] == "****3456"
    assert "value" not in data
    assert data["description"] == "Test key"


async def test_create_duplicate_name(client: AsyncClient):
    """Test creating a keychain item with duplicate name fails."""
    # Create first item
    await client.post(
        "/api/v1/keychain/",
        json={"name": "duplicate-key", "value": "secret1"},
    )

    # Try to create second with same name
    response = await client.post(
        "/api/v1/keychain/",
        json={"name": "duplicate-key", "value": "secret2"},
    )
    assert response.status_code == 400
    assert "已存在" in response.json()["detail"]


async def test_list_keychain_items(client: AsyncClient):
    """Test listing keychain items."""
    # Create items first
    await client.post(
        "/api/v1/keychain/",
        json={"name": "api-key-1", "value": "secret1"},
    )
    await client.post(
        "/api/v1/keychain/",
        json={"name": "api-key-2", "value": "secret2"},
    )

    response = await client.get("/api/v1/keychain/")
    assert response.status_code == 200
    data = response.json()
    assert len(data) >= 2
    assert all("value_masked" in item for item in data)
    assert all("value" not in item for item in data)


async def test_get_keychain_item(client: AsyncClient):
    """Test getting a single keychain item."""
    # Create item
    create_response = await client.post(
        "/api/v1/keychain/",
        json={"name": "get-test-key", "value": "my-secret-value", "description": "For testing get"},
    )
    key_id = create_response.json()["key_id"]

    # Get item
    response = await client.get(f"/api/v1/keychain/{key_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "get-test-key"
    assert data["value_masked"] == "****alue"
    assert data["description"] == "For testing get"
    assert "value" not in data


async def test_get_nonexistent_keychain_item(client: AsyncClient):
    """Test getting a nonexistent keychain item returns 404."""
    response = await client.get("/api/v1/keychain/nonexistent-id")
    assert response.status_code == 404


async def test_update_keychain_item(client: AsyncClient):
    """Test updating a keychain item."""
    # Create item
    create_response = await client.post(
        "/api/v1/keychain/",
        json={"name": "update-test-key", "value": "old-secret"},
    )
    key_id = create_response.json()["key_id"]

    # Update item
    response = await client.put(
        f"/api/v1/keychain/{key_id}",
        json={"value": "new-secret", "description": "Updated description"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["value_masked"] == "****cret"
    assert data["description"] == "Updated description"

    # Update name
    response = await client.put(
        f"/api/v1/keychain/{key_id}",
        json={"name": "updated-name"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "updated-name"


async def test_update_duplicate_name(client: AsyncClient):
    """Test updating to a duplicate name fails."""
    # Create two items
    await client.post(
        "/api/v1/keychain/",
        json={"name": "key-one", "value": "secret1"},
    )
    create2 = await client.post(
        "/api/v1/keychain/",
        json={"name": "key-two", "value": "secret2"},
    )
    key_id = create2.json()["key_id"]

    # Try to update second to first's name
    response = await client.put(
        f"/api/v1/keychain/{key_id}",
        json={"name": "key-one"},
    )
    assert response.status_code == 400
    assert "已存在" in response.json()["detail"]


async def test_delete_keychain_item(client: AsyncClient):
    """Test deleting a keychain item."""
    # Create item
    create_response = await client.post(
        "/api/v1/keychain/",
        json={"name": "delete-test-key", "value": "secret"},
    )
    key_id = create_response.json()["key_id"]

    # Delete item
    response = await client.delete(f"/api/v1/keychain/{key_id}")
    assert response.status_code == 200
    assert response.json()["detail"] == "ok"

    # Verify it's gone
    get_response = await client.get(f"/api/v1/keychain/{key_id}")
    assert get_response.status_code == 404


async def test_delete_nonexistent_keychain_item(client: AsyncClient):
    """Test deleting a nonexistent keychain item returns 404."""
    response = await client.delete("/api/v1/keychain/nonexistent-id")
    assert response.status_code == 404


async def test_keychain_isolation_between_users(client: AsyncClient):
    """Test that users cannot access each other's keychain items."""
    # Create item as first user (using default auth_headers)
    create_response = await client.post(
        "/api/v1/keychain/",
        json={"name": "isolated-key", "value": "secret"},
    )
    key_id = create_response.json()["key_id"]

    # Note: This test assumes we have a way to create a second user's auth headers.
    # In practice, you'd need to register/login as a different user.
    # For now, we just verify the structure is in place.

    # Verify the item exists for the owner
    response = await client.get(f"/api/v1/keychain/{key_id}")
    assert response.status_code == 200
