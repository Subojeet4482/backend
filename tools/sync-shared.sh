#!/bin/sh
# shared/lib is the single source. Run after editing anything in shared/lib.
cp shared/lib/*.js core/lib/ && cp shared/lib/*.js chat/lib/ && echo "synced"
