"""Alembic 环境：Context Store（四层记忆 SQLite）."""
import os
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool, text

from alembic import context

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 从环境变量读取 Context Store 路径，回退到默认值
_raw_path = os.getenv("SQLITE_CONTEXT_PATH", "data/context_store/context.db")
_path = Path(_raw_path)
if not _path.is_absolute():
    # 相对路径相对于 backend/ 目录解析
    _path = Path(__file__).resolve().parent.parent / _raw_path
_path.parent.mkdir(parents=True, exist_ok=True)

sqlalchemy_url = f"sqlite:///{_path}"
config.set_main_option("sqlalchemy.url", sqlalchemy_url)

# Context Store 无 SQLAlchemy ORM 模型，使用 None 表示无 autogenerate 支持
target_metadata = None


def run_migrations_offline() -> None:
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
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        # WAL 模式提升并发安全性
        connection.execute(text("PRAGMA journal_mode=WAL"))
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
