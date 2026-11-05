# OSMANX APP FACTORY R2.4 - deployment wizard engineering preview

**Source baseline:** R1.3.0 (the newest complete ZIP accessible during this work). This is NOT a verified upgrade from R2.3 and does NOT claim the R2.3 webhook / CloudEvents / release-assistant features are present. The source package version is deliberately unchanged at 1.3.0.

## Implemented

- Real Russian-language OBSIDIAN deployment wizard available from a project card and the project release screen.
- Domain validation, optional public IPv4 target, public A/AAAA record diagnostics. Only DNS queries are made; no HTTP requests to the recipient.
- An export endpoint requiring the project owner; validates the project before generating its deployment ZIP.
- Independent CRM or website exports augmented with Dockerfile, Docker Compose, Caddy reverse-proxy TLS configuration, health checks, safe .env generation, local preflight, integrity verification, and operational documentation.
- Never embeds the actual application database, user sessions, customer records, or live setup secrets in the generated bundle. A new initial-admin setup token is generated locally with crypto.randomBytes.
- The existing standalone `manifest.json` is left byte-identical; deployment files use `deploy/manifest.json` to avoid unexpectedly altering the established offline backup / update inventory.
- Container application process runs as `node`, without an internet-exposed direct application port, on a read-only filesystem with a data volume. Caddy owns the only public HTTP/HTTPS ports.
- DNS results and HTTP export are deliberately different operations: a green DNS check is not proof of remote publication or working TLS.

## Verification completed

- `npm run check`: passed.
- `npm test`: **34/34 passed** (31 previous R1.3 tests, three additional R2.4 suites).
- Real Node.js HTTP factory requests and owner-only export checks passed.
- Extracted CRM and website bundles booted independently with temporary SQLite databases; both returned HTTP 200 from `/api/health`.
- Generated `.env` permissions, cryptographic token generation, refusal to overwrite existing `.env`, and both SHA-256 inventories were exercised.
- Static Chromium 1440px desktop / 390px mobile UI checks passed with MOCK HTTP responses and no horizontal overflow.

**NOT verified:** Chromium against the live local server (`net::ERR_BLOCKED_BY_ADMINISTRATOR`); Docker installation/configuration or live reverse-proxy deployment; real public DNS-to-VPS and certificate issuance; external HTTPS E2E; production security or data protection review. Deployment exports are preparation kits, not automatic remote uploads.

## Run the factory

Node.js 22.16+ is required. From `OSMANX_APP_FACTORY_MVP`:

```
node server.mjs
```

Open `http://127.0.0.1:4173`. Create a project, select the deployment wizard, enter the domain, check DNS, and export. Local regression commands:

```
npm run check
npm test
python3 tests/ui_r24_deploy_static.py
```

## On your own VPS: deploy an exported customer application

Have a public VPS, properly configured A/AAAA DNS, firewall rules for TCP ports 80/443 and Docker Engine with the Docker Compose plugin. UDP 443 is optional for HTTP/3. Use Node.js 22+ for the initial secure environment setup. From the extracted deployment ZIP:

```
node deploy/verify.mjs
node deploy/prepare.mjs
node deploy/preflight.mjs
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Verify `https://YOUR-DOMAIN/api/health` only after DNS and certificates are live. Protect `.env` and `SETUP_TOKEN`; do not check in secrets to Git. Back up `app_data` securely to an offsite location and test restore; establish updates, monitoring, incident response and privacy compliance before accepting real customer data.

**Sample industry CRM/site bundles**, if included, use obvious illustrative domain names and have no live connections. For a customer deployment always export again in the wizard using the customer's actual domain.

## Path to a genuine R2.4 release

Obtain the actual R2.3 source ZIP; rebase this feature implementation onto that exact tree, resolve conflicts, rerun the entire existing R2.3 test suite (including webhook HMAC, CloudEvents, queue retry and release assistant), and then test Docker TLS on staging before considering production.
