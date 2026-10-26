#!/usr/bin/env bash
set -euo pipefail

mkdir -p secrets
chmod 700 secrets

python3 -c '
import getpass
import sys
password = getpass.getpass("Dashboard password: ")
confirmation = getpass.getpass("Confirm password: ")
if not password or password != confirmation:
    sys.exit("Passwords are empty or do not match")
sys.stdout.write(password)
' | docker run --rm -i \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" \
  -w /app \
  node:22-alpine \
  node --input-type=module -e '
    import argon2 from "./backend/node_modules/argon2/argon2.cjs";
    import { readFileSync, writeFileSync } from "node:fs";

    const password = readFileSync(0, "utf8");
    if (!password) process.exit(1);

    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
    });

    writeFileSync(
      "secrets/auth_password_hash",
      hash + "\n",
      { mode: 0o600 }
    );

    console.log("Argon2id password hash generated.");
  '

chmod 600 secrets/auth_password_hash
