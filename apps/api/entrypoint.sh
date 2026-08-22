#!/bin/sh
set -eu

node apps/api/dist/repair-production-schema.js
exec node apps/api/dist/server.js
