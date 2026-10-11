---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-26T13:15:16-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-11T14:28:11-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-11T14:28:58-0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-26T13:15:16-0300"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-26T13:15:16-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-26T13:15:16-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-26T13:15:16-0300"
  docs/phases/phase-02-auth/context.md: "2026-09-26T13:15:16-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-26T13:15:16-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-26T13:15:15-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Interface de vídeo no frontend (uploader/player não fazem parte desta fase); comentários, likes, inscrições e demais funcionalidades de fases posteriores.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (uploader e player) fica diferida para fases futuras; o contrato cliente↔storage (upload presigned e streaming por URL) é fixado agora em TD-02/TD-08.

**Sequencing notes:** Depends on Fase 01 (config/DB foundation) and Fase 02 (auth, channels, exception filter, validation).

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta
- **Phase 04:** Gerenciamento de Vídeos e Canal

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Queue Technology | decided | A (BullMQ + Redis) | `bullmq@^6.3.11`, `@nestjs/bullmq@^11.0.5` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large-File Upload Strategy (10GB) | decided | A (Presigned multipart) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage SDK & Bucket Layout | decided | A (@aws-sdk/client-s3) | `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0` |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Execution Model | decided | A (Separate worker service, shared image) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Media Processing Tooling (FFmpeg) | decided | A (System FFmpeg + fluent-ffmpeg) | `fluent-ffmpeg@^2.1.3` |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Lifecycle & Failure Handling | decided | A (Linear lifecycle + retries + error) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Strategy | decided | A (Opaque UUID) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming & Download Delivery | decided | A (Presigned GET + Range/206) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** A (BullMQ + Redis) — matches a self-hosted Docker Compose stack, has the official NestJS 11 integration, and its built-in retries/backoff/concurrency cover exactly what the worker and the status lifecycle need, at the cost of one Redis container.

**Libraries:** `bullmq@^6.3.11`, `@nestjs/bullmq@^11.0.5`

### phase-03-videos/TD-02

**Recommendation:** A (Presigned multipart) — direct-to-storage keeps the API free during the transfer (the phase's core requirement) and multipart is mandatory for anything over 5GB.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** A (`@aws-sdk/client-s3`) — the phase explicitly anticipates swapping to AWS S3 in production; using the AWS SDK keeps app code provider-agnostic while the endpoint simply points at MinIO locally. Bucket layout: two buckets — `streamtube-videos` and `streamtube-thumbnails` — with opaque keys (`videos/{videoId}/{uuid}.mp4`, `thumbnails/{videoId}.jpg`), created/ensured on API startup.

**Libraries:** `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0`

### phase-03-videos/TD-04

**Recommendation:** A (Separate worker service, shared image) — matches the architecture diagram, isolates FFmpeg load from the API, and avoids a second build to maintain.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** A (System FFmpeg + fluent-ffmpeg) — keeps the worker image self-contained with official binaries and gives an ergonomic, well-documented API for the two required tasks (metadata + thumbnail).

**Libraries:** `fluent-ffmpeg@^2.1.3` (system `ffmpeg`/`ffprobe` via apt in the worker image)

### phase-03-videos/TD-06

**Recommendation:** A (Linear lifecycle + retries + error) — satisfies the required cycle exactly (`draft → processing → ready | error`), uses the queue's built-in retries, and keeps the source file so a re-process can be added later without data loss.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** A (Opaque UUID) — guaranteed uniqueness with zero extra machinery; SEO-friendly slugs can be layered on in Fase 04 (video/channel management) without a URL-breaking migration now.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** A (Presigned GET + Range/206) — keeps the API out of the media path entirely, leverages native object-storage Range support, and expresses download as an attachment-disposition presigned URL.

**Libraries:** —

## Inherited Decisions Detail

_Note: this section inherits the decided TDs of the backend-lineage prior phases (phase-01, phase-02) plus the correlator-confirmed ad-hoc doc (`openapi-docs-nestjs`). The `phase-02-auth-frontend` slice is a frontend-runtime phase; its TDs (BFF session, iron-session, react-hook-form) are not applicable to this backend phase and are intentionally not inherited._

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform. PostgreSQL is already in the stack, so no new infrastructure needed.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs. Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with Mailpit for local development, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to a module via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Passwords are hashed with Argon2id; sensitive columns (`password`, token hashes) use TypeORM `{ select: false }`. _(from phase 02)_
- Auth uses custom guards over `@nestjs/jwt` (no Passport); a global JWT guard protects routes, with per-route opt-outs. _(from phase 02)_
- Services throw domain exceptions; a global exception filter maps them to a `{ statusCode, error, message }` contract with machine-readable codes. _(from phase 02)_
- Request payloads are validated with `class-validator`/`class-transformer` DTOs via a global `ValidationPipe`. _(from phase 02)_
- Rate limiting uses `@nestjs/throttler` scoped per module, with `@SkipThrottle()` exemptions. _(from phase 02)_
- Persistence goes through TypeORM repositories; schema changes ship as versioned migrations; entities use a UUID PK plus `@CreateDateColumn`/`@UpdateDateColumn`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` not initialized in that phase; UI surfaces start later. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | UI surfaces deferred to the frontend phase (`next-frontend/`). |
| Confirmação de conta via e-mail com link de ativação (UI landing) | deferred | phase-02-auth-frontend | UI landing screen de-scoped; FE confirmation flow picked up by a future phase. |
| Logout (UI surface) | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome; BFF route handler already ships. |
| Recuperação de senha — tela de destino (set-new-password) | deferred | phase-02-auth-frontend | Destination screen absent from Figma; link destination remains a gap. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de vídeo (uploader/player) no `next-frontend/` | deferred | Escopo da Fase 03 é backend (API, worker, storage, fila); a UI de vídeo não faz parte desta fase. O contrato cliente↔storage é fixado em TD-02/TD-08. | phase-03-videos/TD-02, phase-03-videos/TD-08 |

## Testing Requirements

### nestjs-project

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type. Phase 03 introduces the videos module (entity, services, controllers, DTOs), a queue producer + worker consumer, an object-storage adapter, and new infra (MinIO, Redis, worker) in `compose.yaml`.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`video.entity.ts`) | Integration: constraints, defaults, enum status, relation to `channels` |
| Service with DB + branching (videos lifecycle, upload orchestration) | Unit: branch logic (mock repo) + Integration: real DB contract |
| Service with side-effect dep (storage adapter, queue producer) | Integration: real MinIO / real Redis (do not mock what runs in Compose) |
| Worker consumer (`@Processor`/`WorkerHost`) | Integration: real Redis queue + real MinIO + FFmpeg (thumbnail/metadata) |
| Module with configured imports (BullModule, S3 client) | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Migration (create videos table) | Integration: migration chain (migrations spec) |

Do not mock the queue, storage, or FFmpeg in integration/e2e — the Compose stack provides real MinIO and Redis. Record per-SI coverage in `progress.md`.
