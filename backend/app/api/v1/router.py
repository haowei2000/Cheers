"""API v1 路由聚合."""
from fastapi import APIRouter

from app.api.v1.admin.routes import router as admin_router
from app.api.v1.auth.routes import router as auth_router
from app.api.v1.bots.routes import router as bots_router
from app.api.v1.bulletin.routes import router as bulletin_router
from app.api.v1.channels.routes import router as channels_router
from app.api.v1.context.routes import router as context_router
from app.api.v1.dms.routes import router as dms_router
from app.api.v1.files.routes import router as files_router
from app.api.v1.friends.routes import router as friends_router
from app.api.v1.image_gen.routes import router as image_gen_router
from app.api.v1.keychain.routes import router as keychain_router
from app.api.v1.mcp.routes import router as mcp_router
from app.api.v1.memory.routes import router as memory_router
from app.api.v1.messages.routes import router as messages_router
from app.api.v1.notifications.routes import router as notifications_router
from app.api.v1.openclaw_bridge.routes import router as openclaw_bridge_router
from app.api.v1.search.routes import router as search_router
from app.api.v1.tasks.routes import router as tasks_router
from app.api.v1.templates.routes import router as templates_router
from app.api.v1.todos.routes import router as todos_router
from app.api.v1.workspaces.routes import router as workspaces_router

v1_router = APIRouter(prefix="/api/v1")

v1_router.include_router(workspaces_router)
v1_router.include_router(channels_router)
v1_router.include_router(dms_router)
v1_router.include_router(search_router)
v1_router.include_router(messages_router)
v1_router.include_router(bots_router)
v1_router.include_router(auth_router)
v1_router.include_router(admin_router)
v1_router.include_router(files_router)
v1_router.include_router(context_router)
v1_router.include_router(tasks_router)
v1_router.include_router(friends_router)
v1_router.include_router(mcp_router)
v1_router.include_router(image_gen_router)
v1_router.include_router(bulletin_router)
v1_router.include_router(todos_router)
v1_router.include_router(notifications_router)
v1_router.include_router(keychain_router)
v1_router.include_router(memory_router)
v1_router.include_router(templates_router)
v1_router.include_router(openclaw_bridge_router)

@v1_router.get("/health")
def v1_health():
    return {"status": "ok"}
