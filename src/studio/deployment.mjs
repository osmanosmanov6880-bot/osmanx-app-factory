import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createZip } from '../common/zip.mjs';
import { parseStoredZip } from '../common/archive.mjs';
import { exportProject } from './export.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const reservedTlds = new Set(['local','localhost','test','example','invalid','internal','lan','onion','home','arpa']);

export function normalizeDeploymentDomain(raw) {
  if (typeof raw !== 'string' || raw.length > 255 || raw.trim() !== raw || /[\s\/:?#@]/.test(raw)) throw Error('Enter a bare domain name without a URL, port, path or spaces');
  const domain = domainToASCII(raw).toLowerCase();
  if (!domain || domain.length > 253 || isIP(domain)) throw Error('A public DNS domain is required');
  const labels = domain.split('.');
  if (labels.length < 2 || reservedTlds.has(labels.at(-1)) || labels.some(label =>
    label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw Error('Invalid or reserved public DNS domain');
  }
  if (labels.at(-1).length < 2 || labels.at(-1).startsWith('xn--')) throw Error('Invalid top-level domain');
  return domain;
}

export function isPublicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a,b,c] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
export function isPublicIPv6(value) {
  if (isIP(value) !== 6) return false;
  const s = value.toLowerCase();
  if (s === '::' || s === '::1' || s.startsWith('::ffff:') || s.startsWith('fc') || s.startsWith('fd') ||
      /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('2001:db8:')) return false;
  return true;
}
export function normalizeServerIpv4(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !isPublicIPv4(raw)) throw Error('Server IP must be a public IPv4 address');
  return raw;
}

const emptyRecord = error => ['ENODATA','ENOTFOUND','ENOTIMP','ENOTRESOLVED','NXDOMAIN'].includes(error?.code);
async function resolveAddresses(domain, lookup) {
  const result = await Promise.allSettled([lookup(domain,'A'),lookup(domain,'AAAA')]);
  const out = {A:[],AAAA:[],errors:[]};
  for (let i=0;i<result.length;i++) {
    const key = i===0?'A':'AAAA', item=result[i];
    if (item.status==='fulfilled') {
      if (!Array.isArray(item.value)) out.errors.push(key+': invalid DNS resolver result');
      else out[key] = [...new Set(item.value.filter(v=>typeof v==='string'))].slice(0,20);
    } else if (!emptyRecord(item.reason)) out.errors.push(key+': '+String(item.reason?.code || 'resolver_failed'));
  }
  return out;
}
async function systemLookup(domain,type) {
  const resolver = type==='A'?resolve4:resolve6;
  return Promise.race([
    resolver(domain),
    new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(Error('DNS timeout'),{code:'ETIMEOUT'})),1800))
  ]);
}

export async function deploymentPreflight({domain:rawDomain,serverIp:rawServerIp,checkDns=true,lookup=systemLookup}) {
  const domain=normalizeDeploymentDomain(rawDomain);
  const serverIp=normalizeServerIpv4(rawServerIp);
  const checks=[{id:'domain',status:'ok',title:'Domain name',detail:domain}];
  if(serverIp)checks.push({id:'server',status:'ok',title:'Public server IPv4',detail:serverIp});
  if(!checkDns) {
    checks.push({id:'dns',status:'warning',title:'Public DNS not checked',detail:'No DNS query was sent. This check never sends HTTP requests.'});
    return {domain,serverIp,records:{A:[],AAAA:[]},checks,bundleReady:true,publishReady:false,dnsChecked:false};
  }
  const records=await resolveAddresses(domain,lookup);
  if(records.errors.length)checks.push({id:'dns',status:'warning',title:'DNS lookup incomplete',detail:records.errors.join(', ')});
  const publicA=records.A.filter(isPublicIPv4), publicAAAA=records.AAAA.filter(isPublicIPv6);
  const invalid=[...records.A.filter(v=>!isPublicIPv4(v)),...records.AAAA.filter(v=>!isPublicIPv6(v))];
  if(invalid.length)checks.push({id:'dns-private',status:'error',title:'Non-public DNS addresses',detail:invalid.join(', ')});
  if(!publicA.length && !publicAAAA.length)checks.push({id:'dns-records',status:'warning',title:'No public A/AAAA records',detail:'Point the domain to your public server and wait for DNS propagation.'});
  else checks.push({id:'dns-records',status:'ok',title:'Public DNS records',detail:[...publicA,...publicAAAA].join(', ')});
  if(serverIp && !publicA.includes(serverIp))checks.push({id:'server-match',status:'warning',title:'IPv4 mismatch / possible CDN proxy',detail:'DNS A records do not contain the expected server IPv4. A proxy or DNS misconfiguration may explain this.'});
  const publishReady = !checks.some(c=>c.status==='error'||c.status==='warning') && (publicA.length+publicAAAA.length>0);
  return {domain,serverIp,records:{A:records.A,AAAA:records.AAAA},checks,bundleReady:true,publishReady,dnsChecked:true};
}

function makeDeployFiles(project,domain,applicationManifest,maintenanceSource,liveSource,upgradeSource,volumeSource,rolloutSource,signatureSource,trustSource,doctorSource,fleetSource,telemetrySource,edgeSource,incidentSource) {
  const site=project.type==='site';
  const port=site?4181:4180;
  const envTemplate = [
    '# Prepared by OSMANX deployment wizard. Never commit .env to Git.',
    'APP_DOMAIN='+domain,
    'HOST=0.0.0.0',
    'PORT='+port,
    'DATA_DIR=/app/data',
    'COOKIE_SECURE=1',
    'SETUP_TOKEN=REPLACE_WITH_RANDOM_TOKEN_RUN_NODE_DEPLOY_PREPARE',
    ...(site?['PUBLIC_SITE_URL=https://'+domain]:[]),
    ''
  ].join('\n');
  const dockerfile = `FROM node:22-bookworm-slim\nWORKDIR /app\nENV NODE_ENV=production\nCOPY --chown=node:node . .\nRUN mkdir -p /app/data && chown -R node:node /app/data\nUSER node\nEXPOSE ${port}\nHEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "deploy/healthcheck.mjs"]\nCMD ["node", "run.mjs"]\n`;
  const compose = `name: osmanx_${project.id.replaceAll('-','').slice(0,12)}\nservices:\n  app:\n    build:\n      context: .\n      dockerfile: Dockerfile\n    restart: unless-stopped\n    stop_grace_period: 90s\n    env_file:\n      - .env\n    volumes:\n      - app_data:/app/data\n    expose:\n      - "${port}"\n    read_only: true\n    tmpfs:\n      - /tmp\n    cap_drop:\n      - ALL\n    security_opt:\n      - no-new-privileges:true\n    healthcheck:\n      test: ["CMD", "node", "deploy/healthcheck.mjs"]\n      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 20s\n  gateway:\n    image: caddy:2-alpine\n    restart: unless-stopped\n    stop_grace_period: 30s\n    ports:\n      - "80:80"\n      - "443:443"\n      - "443:443/udp"\n    environment:\n      APP_DOMAIN: \${APP_DOMAIN:?Configure APP_DOMAIN in .env}\n    volumes:\n      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro\n      - caddy_data:/data\n      - caddy_config:/config\n    depends_on:\n      app:\n        condition: service_healthy\n  maintenance:\n    profiles: ["maintenance"]\n    build: .\n    user: "node"\n    network_mode: "none"\n    read_only: true\n    tmpfs: ["/tmp"]\n    cap_drop: [ALL]\n    security_opt: ["no-new-privileges:true"]\n    env_file: [".env"]\n    volumes:\n      - app_data:/app/data\n      - ./backups:/backups\n    entrypoint: ["node", "deploy/maintenance.mjs"]\nvolumes:\n  app_data:\n  caddy_data:\n  caddy_config:\n`;
  const caddyfile=`{$APP_DOMAIN} {\n    encode zstd gzip\n    reverse_proxy app:${port}\n    header {\n        X-Content-Type-Options nosniff\n        Referrer-Policy same-origin\n        X-Frame-Options DENY\n    }\n}\n`;
  const prepare=`import { randomBytes } from 'node:crypto';\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\nconst root=resolve(import.meta.dirname,'..');\nconst template=readFileSync(resolve(root,'deploy/.env.example'),'utf8');\nconst value=template.replace('REPLACE_WITH_RANDOM_TOKEN_RUN_NODE_DEPLOY_PREPARE',randomBytes(32).toString('hex'));\nprocess.umask(0o077);\ntry{writeFileSync(resolve(root,'.env'),value,{flag:'wx',mode:0o600});console.log('Created .env with a random setup token. Keep it private.');}\ncatch(e){if(e.code==='EEXIST')throw Error('Existing .env kept intact; refusing to overwrite secrets');throw e;}\n`;
  const preflight=`import { readFileSync, existsSync } from 'node:fs';\nimport { resolve } from 'node:path';\nconst root=resolve(import.meta.dirname,'..');\nconst envPath=resolve(root,'.env');\nif(!existsSync(envPath))throw Error('Missing .env; run node deploy/prepare.mjs');\nconst data=Object.fromEntries(readFileSync(envPath,'utf8').split(/\\r?\\n/).filter(s=>s&&!s.startsWith('#')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}));\nif(data.APP_DOMAIN!==${JSON.stringify(domain)})throw Error('APP_DOMAIN differs from prepared deployment domain');\nif(!data.SETUP_TOKEN||data.SETUP_TOKEN.length<32||data.SETUP_TOKEN.includes('REPLACE_'))throw Error('Invalid setup token');\nif(data.COOKIE_SECURE!=='1'||data.HOST!=='0.0.0.0'||data.PORT!=='${port}')throw Error('Unsafe server parameters');\n${site?`if(data.PUBLIC_SITE_URL!=='https://${domain}')throw Error('PUBLIC_SITE_URL mismatch');`:''}\nconsole.log('Local environment verified. This does not verify remote DNS, HTTPS or deployment.');\n`;
  const verify=`import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const hash=data=>createHash('sha256').update(data).digest('hex');
const appBytes=readFileSync(resolve(root,'manifest.json'));
const application=JSON.parse(appBytes.toString());
const deployment=JSON.parse(readFileSync(resolve(root,'deploy/manifest.json'),'utf8'));
if(deployment.applicationManifestSha256!==hash(appBytes))throw Error('Application manifest was changed');
let count=0;
for(const files of [application.files,deployment.files]){
 if(!files||typeof files!=='object'||Array.isArray(files))throw Error('Invalid file inventory');
 for(const [name,digest] of Object.entries(files)){
  if(!/^[a-zA-Z0-9_.\/-]+$/.test(name)||name.split('/').some(p=>p==='.'||p==='..'))throw Error('Invalid inventory path');
  const path=resolve(root,name);
  if(!path.startsWith(root+sep))throw Error('Path escapes project directory');
  if(hash(readFileSync(path))!==digest)throw Error('Checksum mismatch: '+name);
  count++;
 }
}
console.log('Verified '+count+' application and deployment files. SHA256 is NOT a publisher signature.');
`;
  const health=`const port=Number(process.env.PORT||${port});\ntry{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),3000);const r=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:controller.signal});clearTimeout(timeout);process.exit(r.ok?0:1);}catch{process.exit(1);}\n`;
  const guide = `# OSMANX R3.2 Preview deployment kit\n\nProject: ${String(project.name).replace(/\s+/g,' ').slice(0,80)}\nType: ${site?'website':'CRM'}\nDomain: ${domain}\n\nThis kit prepares a Docker Compose deployment; it DOES NOT deploy remotely on its own.\n\nOn your VPS (public ports 80 and 443 open, Docker Engine with Compose plugin installed):\n1. Unzip this bundle into an empty directory.\n2. Configure DNS A record for ${domain} to your VPS public IPv4. DNS can take time to propagate.\n3. Install Node.js 22+ on the VPS for the one-time safe secret setup, or prepare the .env securely on your admin machine.\n4. Run: node deploy/verify.mjs (internal integrity check, not a publisher signature)\n5. Run: node deploy/prepare.mjs\n6. Run: node deploy/preflight.mjs\n7. Run: docker compose config --quiet\n8. Prepare an offline backup folder: mkdir -p backups && sudo chown 1000:1000 backups && chmod 700 backups\n9. Run: docker compose up -d --build\n10. Check: docker compose ps\n11. Verify actual external HTTPS + valid TLS certificate: node deploy/verify-live.mjs --live\n12. Open: https://${domain}/ and finish initial administrator setup using the private SETUP_TOKEN from .env.\n\nYour .env contains secrets; never put it into Git, customer support tickets, or screenshots. The archive itself has no live customer records or login credentials.\nHTTPS is obtained and renewed by Caddy only after public DNS, reachable 80/443, and a working deployment. The wizard does not make external HTTP requests. The optional verify-live command performs an actual HTTPS GET to /api/health and checks the TLS certificate and JSON status, using a pinned public IPv4 DNS result. Run ONLY on the installed VPS after deployment, not from the factory. It does not test a browser or business transactions.\nBackups: first run docker compose stop app; then docker compose --profile maintenance run --rm --no-deps maintenance backup. Restart with docker compose up -d app. The returned backup ID can be checked using maintenance verify BACKUP_ID. Restoring is destructive and requires maintenance restore BACKUP_ID --confirm with app stopped. Backup files appear in ./backups and hold personal data; encrypt and copy off-server. Keep backups directory private (UID/GID 1000).

Compose uses a fixed project name derived from project UUID to preserve named volumes across directories when both kits use format v2. Old v1 kits from R2.4 had folder-dependent Compose volumes and MUST NOT be upgraded by just replacing the Compose file: manually migrate their volumes first.

Back up the app_data Docker volume and Caddy TLS volumes, store encrypted off-server copies, test restore and harden the VPS before production.\nDo NOT run ops.mjs update/restore while the app is serving requests. Use deploy/upgrade.mjs plan/apply/recover for versioned R2.6 deployment kits. Always test on staging first, and never update old R2.4 folder-dependent volumes automatically.\nR2.6 upgrade steps: create a saved Release in the Factory, export its deployment kit with the same domain, copy the ZIP to your VPS, and run \`node deploy/upgrade.mjs plan /path/next.zip\`. After accepting downtime, run \`node deploy/upgrade.mjs apply /path/next.zip --confirm\`. This stops the app, makes an offline SQLite backup, updates only declared files, waits for Compose healthcheck and restores old code and DB if startup fails. To resume interrupted updates use \`node deploy/upgrade.mjs recover --confirm\`. View the journal with \`node deploy/upgrade.mjs status\`. For R2.5 installations that lack this command, run the R2.6 script from an extracted NEW kit and add \`--installed=/path/to/old/kit\` to every command. The VPS must already have Docker Compose and access to backup volumes. Hashes are not digital signatures. If rollback fails, inspect the journal and use the manual backup procedure. Re-check HTTPS after each update.\n
R2.7 LEGACY VOLUME MIGRATION: old R2.4 deployment kits (format v1) used a folder-dependent Docker Compose project. R2.7 has a fixed Compose project and must NOT start with empty volumes. Stop BOTH old and new stacks, then use the R2.7 script: \`node deploy/volume-migrate.mjs plan --legacy=/srv/legacy-kit --legacy-project=old_compose_name\` to inspect volume labels and verify identities. The legacy project name must be the exact original Docker Compose project name, not a guessed folder name. Keep the source kit unchanged. Pull the helper image \`docker pull node:22-bookworm-slim\` explicitly before migration; this operation runs entirely offline and makes a private host snapshot first. Once reviewed and approved, run \`node deploy/volume-migrate.mjs migrate --legacy=/srv/legacy-kit --legacy-project=old_compose_name --offline-confirmed --confirm\`. To inspect the journal: \`node deploy/volume-migrate.mjs status\`. On an interrupted/partial migration, DO NOT start the new stack, review \`status\` and run \`node deploy/volume-migrate.mjs recover --confirm --recreate-targets\`. Recovery deletes ONLY target volumes labeled with that exact migration ID, refusing any target in use. Old source volumes are always preserved. Caddy volumes are copied only when present. The backup directory \`.osmanx-volume-migration/snapshots\` holds personal data; never publish it. A complete migration means files copied and hashed, NOT validated public HTTPS or a guaranteed schema migration. Use \`deploy/upgrade.mjs\` for release-to-release code changes only after the data migration is complete.
R2.8 OFFLINE VERIFICATION: after migrate, before starting a new stack, run \`node deploy/volume-migrate.mjs verify\`. It checks source, sealed backup and migrated target hashes, file metadata, SQLite integrity, Docker labels and stopped-state. The result is ONLY offline data consistency, never live application/HTTPS readiness. If backup was interrupted, first inspect \`status\`, then (only after confirming the original volumes are unchanged) run \`node deploy/volume-migrate.mjs recover --confirm --recreate-targets --retry-backups\`. Incomplete snapshots are kept in the private snapshots folder, so adequate free disk space is mandatory. R2.8 migration journals and copied files are fsynced where supported. Do not use verify while either stack is running. A public deployment still requires live Docker, Caddy TLS and business-data acceptance tests.
R2.9 LOCAL ROLLOUT OBSERVATION: the controlled update executes three sequential app-container health checks after startup while the public gateway is stopped, verifies the Compose project identity and rejects unexpected container replacement/restarts. Only after a stable observation does the controller start the public gateway. A failed observation triggers the existing rollback and writes a private non-PII report to .osmanx-rollout. Run node deploy/rollout-observe.mjs observe --samples=3 --interval-ms=3000 to recheck on the host after deployment and node deploy/rollout-observe.mjs history to inspect the latest checks. This is an on-demand bounded check, NOT continuous monitoring, real public HTTPS verification, or an SRE service. For external TLS check, run node deploy/verify-live.mjs --live. The local Docker Engine must be present. Keep private history out of Git and Docker images.
R3.0 SIGNED RELEASES: offline signing on the trusted factory workstation:
  node scripts/release_sign.mjs keygen --private=/offline/release-private.pem --public=/offline/release-public.pem
  node scripts/release_sign.mjs sign exported.zip --private=/offline/release-private.pem --out=signed.zip
  node scripts/release_sign.mjs verify signed.zip --public=/offline/release-public.pem
For update installations, provision the trusted publisher PUBLIC key on the VPS in .osmanx-trust/release-public.pem (parent directory chmod 700, public key not group/world writable). Keep the PRIVATE key only on a separately protected signing workstation, never in a project archive, Git or Docker. When the trusted key is pinned, unsigned and wrongly signed packages are rejected BEFORE Docker stops. Run plan/apply with --require-signature if you require a signed release even before a local trust directory has been provisioned (no key => an explicit refusal). Ed25519 authenticates who has the signing key, not whether the update is bug-free. Rotate a compromised publisher key only via an independently verified administrator procedure. Do not ship test signing keys to clients.
R3.1 SAFE FORWARD RESUME: if an upgrade ends in 'manual-review-required', the external gateway MAY have accepted client writes. Do not run a database restore or force an old snapshot. Inspect 'node deploy/upgrade.mjs status', confirm the installed new version is correct, and only then run 'node deploy/upgrade.mjs resume --confirm'. Resume requires the pinned Ed25519 signer, checks all managed file hashes and the installed detached signature, observes Docker health and reopens the gateway without rewriting SQLite. If those checks fail, ingress is stopped and the incident remains open for manual investigation. Never run resume for an unknown release or an older unverified package. 'recover --confirm' remains only for the pre-activation rollback path.
R3.2 PUBLISHER KEY ROTATION (operator-only): pin an out-of-band verified public key using \`node deploy/trust-policy.mjs init --key=/secure/publisher.pem --confirm\`. Add a second publisher key *before* rotating with \`add --key=/secure/new-publisher.pem --confirm\`; after all active installs have been updated, revoke a previous key with \`revoke --fingerprint=SHA256 --confirm\`. A revoked key cannot be reactivated. Trust state is outside ZIP and never updated by an application release. Keep at least one active key.
R3.2 RESTORE DRILL: while app is stopped, run \`docker compose --profile maintenance run --rm --no-deps maintenance drill BACKUP_ID\`. It restores into a disposable private directory, checks SQLite and deletes the temporary copy; customer data is not printed. Exercise off-server encrypted backup restoration independently.
R3.2 DEPLOYMENT DOCTOR: \`node deploy/doctor.mjs --out=/private/acceptance.json\` performs offline manifest, signature and configuration checks without DNS, HTTP or Docker; \`--docker\` explicitly checks Compose configuration, and \`--live\` explicitly probes public HTTPS identity. A report is not a security audit or production certification.
R3.7 EDGE ACCEPTANCE: node deploy/edge-audit.mjs --dns-only performs DNS-only checks without HTTPS. node deploy/edge-audit.mjs --live checks every resolved PUBLIC A/AAAA target for valid TLS and exact project/release identity, with no redirects or credentials. Do not claim global reachability from a single VPS.
R3.7 PRIVATE INCIDENT EVIDENCE: node deploy/incident-evidence.mjs --out=/private/incident.json creates an offline operator report with allowlisted status fields only; --live explicitly runs the public edge audit. Save reports OUTSIDE the installation. Reports have no author signature; they do not replace signed Fleet snapshots.
R3.7 Docker E2E: npm run docker:e2e:r37 is a separate synthetic-only CI runner, not a command to execute against production customer volumes.
R3.1 PUBLIC HTTPS IDENTITY: 'node deploy/verify-live.mjs --live' now checks the valid TLS certificate and verifies that /api/health belongs to the expected project UUID, service type and saved release sequence. It will refuse a different app, project or version even if that host returns HTTP 200. The health endpoint exposes only service and release identity, not client records or secrets. Public verification must be run explicitly after Docker/Caddy startup; the factory itself does not contact the client domain.
The separate GitHub Actions workflow r31-release-acceptance.yml runs the real Docker synthetic signed-upgrade/rollback/forward-resume test on an Ubuntu runner. Workflow presence is not proof that it has executed successfully.
The deployment assets are tracked separately in deploy/manifest.json; the original application manifest.json is deliberately unchanged for compatibility with existing local backup/update logic.\n${site?'This site collects leads and personal data; implement a privacy policy and retention limits.':'CRM payment records are a manual ledger, not real card acquiring.'}\n`;
  const files = [
    {name:'Dockerfile',data:dockerfile},
    {name:'compose.yaml',data:compose},
    {name:'.dockerignore',data:'.env\n.git\ndata\nbackups\n*.pem\n*.key\nrelease-keys\n.osmanx-trust\n.osmanx-upgrades\n.osmanx-volume-migration\n.osmanx-rollout\n.osmanx-acceptance\n.osmanx-fleet\nqa\ntests\n*.zip\n*.log\n'},
    {name:'deploy/Caddyfile',data:caddyfile},
    {name:'deploy/.env.example',data:envTemplate},
    {name:'deploy/prepare.mjs',data:prepare},
    {name:'deploy/preflight.mjs',data:preflight},
    {name:'deploy/verify.mjs',data:verify},
    {name:'deploy/healthcheck.mjs',data:health},
    {name:'deploy/maintenance.mjs',data:maintenanceSource},
    {name:'deploy/verify-live.mjs',data:liveSource},
    {name:'deploy/edge-audit.mjs',data:edgeSource},
    {name:'deploy/incident-evidence.mjs',data:incidentSource},
    {name:'deploy/upgrade.mjs',data:upgradeSource},
    {name:'deploy/volume-migrate.mjs',data:volumeSource},
    {name:'deploy/rollout-observe.mjs',data:rolloutSource},
    {name:'deploy/signature.mjs',data:signatureSource},
    {name:'deploy/trust-policy.mjs',data:trustSource},
    {name:'deploy/doctor.mjs',data:doctorSource},
    {name:'deploy/fleet-agent.mjs',data:fleetSource},
    {name:'deploy/telemetry-read.mjs',data:telemetrySource},
    {name:'deploy/DEPLOY.md',data:guide}
  ];
  const meta = {format:'osmanx-deployment-kit',version:2,projectId:project.id,domain,
    composeProject:'osmanx_'+project.id.replaceAll('-','').slice(0,12),
    applicationManifestSha256:sha256(applicationManifest),
    files:Object.fromEntries(files.map(f=>[f.name,sha256(f.data)]))};
  files.push({name:'deploy/manifest.json',data:JSON.stringify(meta,null,2)+'\n'});
  return files;
}

export async function exportDeploymentBundle(project,root,rawDomain,release=null) {
  const domain=normalizeDeploymentDomain(rawDomain);
  const base=await exportProject(project,root,release);
  const entries=parseStoredZip(base,{maxFiles:350,maxBytes:60*1024*1024});
  if(!entries.has('manifest.json'))throw Error('Missing base application manifest');
  const files=[...entries].map(([name,data])=>({name,data}));
  const [maintenance,live,upgrade,volumes,rollout,signature,trust,doctor,fleet,telemetryRead,edgeAudit,incident]=await Promise.all([readFile(new URL('../../templates/deploy/maintenance.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/verify-live.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/upgrade.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/volume-migrate.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/rollout-observe.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/signature.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/trust-policy.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/doctor.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/fleet-agent.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/telemetry-read.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/edge-audit.mjs',import.meta.url)),readFile(new URL('../../templates/deploy/incident-evidence.mjs',import.meta.url))]);
  const deployUpgrade=upgrade.toString('utf8').replace("from '../../src/common/archive.mjs'","from '../src/common/archive.mjs'");
  const deployedFleet=fleet.toString('utf8').replace("from '../../src/common/runtime-health.mjs'","from '../src/common/runtime-health.mjs'");
  const deployedTelemetry=telemetryRead.toString('utf8').replace("from '../../src/common/runtime-health.mjs'","from '../src/common/runtime-health.mjs'");
  const extras=makeDeployFiles(project,domain,entries.get('manifest.json'),maintenance,live,deployUpgrade,volumes.toString('utf8'),rollout.toString('utf8'),signature.toString('utf8'),trust.toString('utf8'),doctor.toString('utf8'),deployedFleet,deployedTelemetry,edgeAudit.toString('utf8'),incident.toString('utf8'));
  for(const file of extras)if(entries.has(file.name))throw Error('Existing deployment asset conflict: '+file.name);
  return createZip([...files,...extras]);
}
