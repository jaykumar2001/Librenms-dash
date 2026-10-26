# Secure credential configuration

LibreNMS-Dash supports file-based credentials and Argon2id
password hashes while retaining legacy environment-variable
configuration for backward compatibility.

## Secure Docker Compose deployment

Use the standalone secure Compose file:

    docker compose -f docker-compose.secrets.yaml config --quiet

Do not combine it with docker-compose.yaml. Combining the
files can reintroduce plaintext credential environment variables.

Set AUTH_USERNAME in a local .env file.

Create a secrets directory and protect it:

    mkdir -p secrets
    chmod 700 secrets

The secure Compose configuration expects:

- secrets/librenms_token
- secrets/auth_password_hash

The first contains the LibreNMS API token.
The second contains an Argon2id encoded password hash.

Never commit either file.


## Generate a password hash

Install the project's dependencies first.

Generate an Argon2id hash using the installed backend dependency.
Use an interactive password prompt so the plaintext password does
not appear in shell history or process arguments.

The generated hash belongs in:

    secrets/auth_password_hash

The LibreNMS API token belongs in:

    secrets/librenms_token

Protect both files:

    chmod 600 secrets/librenms_token secrets/auth_password_hash

## Configuration options

LIBRENMS_TOKEN_FILE specifies the LibreNMS API token file.

LIBRENMS_PASS_FILE optionally specifies the LibreNMS web password
file used for route polling.

AUTH_PASSWORD_HASH_FILE specifies the Argon2id password hash file.

AUTH_USERNAME specifies the dashboard login username.

Legacy plaintext environment variables remain supported for
backward compatibility.

Do not configure both the plaintext and file-based forms of
the same credential.

## Start the secure deployment

Set AUTH_USERNAME in your local .env file.

Validate configuration without printing credentials:

    docker compose -f docker-compose.secrets.yaml config --quiet

Start the application:

    docker compose -f docker-compose.secrets.yaml up -d --build

Do not combine the secure Compose file with the legacy Compose file.

## Security considerations

Docker Compose file-based secrets are not encrypted-at-rest
secret management.

Host administrators and users with Docker daemon permissions
may still retrieve application secrets.

Do not share unredacted output from:

- docker compose config
- docker inspect
- process environment dumps
- application logs containing sensitive information

Rotate credentials that have previously been exposed.

The application currently disables upstream TLS certificate
verification for HTTPS connections. This is a separate security
issue that should be addressed independently.

## Interactive password hash generation

After installing project dependencies, generate a hash with:

    ./scripts/hash-password.sh

The script prompts for the password without displaying it.
It writes the Argon2id hash to:

    secrets/auth_password_hash

The resulting hash is suitable for AUTH_PASSWORD_HASH_FILE.

Running the script again replaces the existing hash.
Existing login passwords will no longer work after the new
configuration is deployed.
