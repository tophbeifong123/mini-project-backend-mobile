# B01 Architecture & Containerization
scope: monolith vs microservices; devops/cicd; iac; docker; node dockerfile

## decide
- default monolith, modular by domain. split only on measured bottleneck or team>15-20.
- microservices cost: service discovery, tracing, contract tests, api versioning, partial failure, saga. needs platform team.
- db-per-service => no cross-service ACID. reject split if business needs it.

## dockerfile rules
- multi-stage: builder runs full `npm ci` + `npm run build`; final stage copies only `dist` + prod deps.
- `COPY package*.json` before `COPY . .` => `npm ci` layer stays cached on source edits.
- alpine base; pin exact tag (never `latest`); also tag image with commit SHA for rollback.
- `USER node` before CMD.
- `npm ci --omit=dev` (NOT `--only=production`, deprecated npm7+).
- `.dockerignore`: node_modules .git .env* dist coverage — prevents secret leaking into layers.
- HEALTHCHECK + /health that pings real deps.

## secrets
- env vars at runtime only. never bake into image (`docker history` exposes layers).
- `.env` in .gitignore. committed secret => rotate, deleting file is insufficient.
- separate dev/prod secrets. prod from secrets manager (audit + rotate w/o redeploy).
- `--env-file` is dev-only: values readable via `docker inspect`.
- validate env at boot, crash fast.

## runtime
- always set `--memory` `--cpus` `--pids-limit` (noisy neighbor + cost).
- node<18 ignores cgroup limits => set NODE_OPTIONS=--max-old-space-size to match --memory.
- custom network => service discovery by container name (`postgresql://db:5432`).
- `depends_on` waits for start not readiness. use `condition: service_healthy` or app-side retry.
- image size 1.2GB -> ~150MB via multi-stage+alpine+prod-deps.

## do-not
- microservices on greenfield; root container; `latest` tag; hardcoded secrets; commit .env; shared dev/prod secrets; naive `FROM node:20 + COPY . . + npm install`.

## slide-errata (source code is broken, do not copy)
1. slide20 "optimized": builder runs `npm ci --only=production` + `COPY . .` but NO `npm run build`; final does `COPY --from=builder /app .` (drags source+node_modules). multi-stage gains nothing. use slide21 instead.
2. slide29 multi-target: references `COPY --from=builder` but defines only base/development/production stages. build fails.
3. `--only=production` deprecated -> `--omit=dev`.
4. `version: '3.8'` in compose is obsolete/ignored in Compose v2.
5. slide24 recommends `--env-file .env.production`, contradicting slide25 secrets-manager guidance.
