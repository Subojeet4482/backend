#!/bin/sh
# usage: ./tools/set-webhook.sh <BOT_TOKEN> <https://your-service.vercel.app> <TG_WEBHOOK_SECRET>
curl -s "https://api.telegram.org/bot$1/setWebhook" -d "url=$2/tg/webhook" -d "secret_token=$3" -d 'allowed_updates=["message","callback_query"]'
echo
curl -s "https://api.telegram.org/bot$1/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[{"command":"menu","description":"Open control panel"}]}'
echo
