import os
from logging.config import fileConfig

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

from app.db.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 从环境或 .env 读取数据库 URL；Alembic 使用同步驱动
database_url = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///data/main.db",
)
# 同步 URL 供 Alembic 使用（SQLite 去掉 +aiosqlite；PostgreSQL 则去掉 +asyncpg）
if "+aiosqlite" in database_url:
    sqlalchemy_url = database_url.replace("+aiosqlite", "", 1)
elif "+asyncpg" in database_url:
    sqlalchemy_url = database_url.replace("+asyncpg", "", 1)
else:
    sqlalchemy_url = database_url
config.set_main_option("sqlalchemy.url", sqlalchemy_url)

target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
