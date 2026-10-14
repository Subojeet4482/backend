from __future__ import annotations

import logging

from telegram import Update

from telegram_manager.bot.registry import build_application
from telegram_manager.config import Settings
from telegram_manager.log_setup import setup_logging
from telegram_manager.web.access import LogAccess
from telegram_manager.web.health import HealthMonitor
from telegram_manager.web.server import start_http_server

logger = logging.getLogger(__name__)


def main() -> None:
    settings = Settings.from_env()
    log_buffer = setup_logging(settings.log_level)
    logger.info(
        "Starting | port=%s timezone=%s self_ping=%s public_url=%s",
        settings.port,
        settings.timezone,
        f"every {settings.self_ping_interval}s" if settings.self_ping_url else "off",
        settings.public_url or "not set",
    )
    log_access = LogAccess()
    health = HealthMonitor()
    server = start_http_server(
        settings.port, log_buffer, log_access, health, secure_cookies=settings.secure_cookies
    )
    application = build_application(settings, log_buffer, log_access, health)
    manager = application.bot_data["manager"]
    server.status_provider = manager.status_summary  # type: ignore[attr-defined]
    health.status_provider = manager.status_summary
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
