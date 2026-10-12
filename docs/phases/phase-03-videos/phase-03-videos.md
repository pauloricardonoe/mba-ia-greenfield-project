---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-11T14:29:23-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-11T14:28:58-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-11T14:28:11-0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-26T13:15:16-0300"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-26T13:15:16-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-26T13:15:16-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar a fundação de vídeo do StreamTube: armazenamento de arquivos (S3/MinIO), fila de processamento em segundo plano e worker de vídeo (FFmpeg), upload de arquivos de até 10GB direto ao storage sem travar a API, pré-cadastro automático do vídeo como rascunho, processamento automático (extração de duração/metadados e geração de thumbnail), URL única por vídeo, reprodução via streaming e download — com os entregáveis: upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Dependências, Namespaces de Configuração e Infra no Compose

**Description:** Instalar as dependências da Fase 03, criar os namespaces de configuração `storage` e `queue` (padrão `registerAs` da Fase 01), estender o schema Joi e adicionar os serviços MinIO e Redis ao Compose.

**Technical actions:**

1. Instalar dependências de produção em `nestjs-project`: `@nestjs/bullmq@^11.0.5`, `bullmq@^6.3.11`, `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0`, `fluent-ffmpeg@^2.1.3` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-05`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_HOST` (default `minio`), `S3_PORT` (default `9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_VIDEOS_BUCKET` (default `streamtube-videos`), `S3_THUMBNAILS_BUCKET` (default `streamtube-thumbnails`), `S3_PRESIGN_EXPIRY_SECONDS` (default `3600`) (per `phase-03-videos/TD-03`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` e `.env.example` com as novas variáveis
5. Adicionar ao `compose.yaml` os serviços `minio` (`minio/minio`, comando `server /data --console-address ":9001"`, portas 9000/9001, volume) e `redis` (`redis:7-alpine`, porta `${REDIS_HOST_PORT:-6379}:6379`); `nestjs-api` passa a depender de ambos (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- A aplicação sobe sem erros com as novas variáveis; o E2E `GET /` continua retornando 200
- Sem `S3_ACCESS_KEY`/`S3_SECRET_KEY` o bootstrap falha com erro de validação Joi
- `docker compose up` sobe `minio` (console em `localhost:9001`) e `redis`; o `minio` fica healthy

---

### SI-03.2 — Entidade Video e Migration

**Description:** Criar a entidade `Video` ligada ao canal e gerar a migration da tabela `videos`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do Data Model (`id`, `channel_id`, `title`, `status`, `source_key`, `thumbnail_key`, `duration_seconds`, `metadata`, `error_message`, `created_at`, `updated_at`), `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e índices em `channel_id` e `status` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
2. Criar `src/videos/videos.constants.ts` — enum `VideoStatus` (`draft` | `processing` | `ready` | `error`) e o nome da fila `VIDEO_QUEUE` = `video-processing` (per `phase-03-videos/TD-06`)
3. Gerar a migration `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, enum, relation | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria `videos` com todas as colunas, constraints e índices
- Um vídeo criado sem status tem `status = 'draft'`
- Um status fora do enum é rejeitado pelo banco
- O vídeo referencia um canal via `channel_id` (FK) e a relação carrega com `relations: ['channel']`

---

### SI-03.3 — Módulo de Storage (cliente S3, buckets e presign)

**Description:** Criar o `StorageModule` com um cliente S3 apontando para o MinIO, garantindo a existência dos buckets na inicialização, e um `StorageService` que expõe presign de multipart e de GET.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` — `S3Client` (endpoint `http://{host}:{port}`, `forcePathStyle: true`, credenciais do config) com métodos `ensureBuckets()`, `createMultipartUpload(key)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)` e `presignGetObject(key, { expiresIn, download? })` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
2. Criar `src/storage/storage.module.ts` — `StorageModule` global exportando `StorageService`; `onModuleInit` chama `ensureBuckets()`
3. Registrar `StorageModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO (ensureBuckets, presign put/get, multipart init/complete) | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `ensureBuckets()` cria `streamtube-videos` e `streamtube-thumbnails` se ausentes e é idempotente
- `createMultipartUpload` retorna um `uploadId`; `presignUploadPart` retorna uma URL PUT que o MinIO aceita
- `presignGetObject` retorna uma URL GET que o MinIO responde com 200 — e com 206 quando recebe header `Range`

---

### SI-03.4 — Pré-cadastro de Vídeo e Início do Upload Multipart

**Description:** Implementar o `VideosService` (pré-cadastro do vídeo como rascunho) e os endpoints `POST /videos` e `POST /videos/:id/upload-urls`, que devolvem as URLs pré-assinadas de multipart.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` — `createDraft(channelId, title)` (persiste com status `draft`) e `startUpload(videoId, channelId, sizeBytes)` (valida ≤ 10 GiB, valida status `draft`, chama `createMultipartUpload`, calcula `partSize` e presigna cada parte) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
2. Criar DTOs `src/videos/dto/create-video.dto.ts` (`title`) e `src/videos/dto/start-upload.dto.ts` (`sizeBytes`) com class-validator
3. Criar `src/videos/videos.controller.ts` — `POST /videos` (201) e `POST /videos/:id/upload-urls` (200), resolvendo o canal do usuário autenticado (per `phase-03-videos/TD-02`)
4. Criar exceções `VideoNotFoundException`, `VideoNotDraftException`, `VideoTooLargeException` em `src/videos/exceptions/`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft/startUpload` | Unit: branch logic (size > 10 GiB, status ≠ draft) + Integration: real DB + MinIO | `src/videos/videos.service.integration-spec.ts` |
| `CreateVideoDto` / `StartUploadDto` | E2E: validation wiring | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` autenticado retorna 201 com `{ id, title, status: 'draft' }`
- `POST /videos/:id/upload-urls` com `sizeBytes` válido retorna `uploadId`, `key`, `partSize` e `parts[].url`
- `sizeBytes` > 10 GiB retorna 413 `VIDEO_TOO_LARGE`
- `upload-urls` em vídeo não-`draft` retorna 409 `VIDEO_NOT_DRAFT`
- `upload-urls` em vídeo de outro canal retorna 404 `VIDEO_NOT_FOUND`

---

### SI-03.5 — Conclusão do Upload Multipart e Enfileiramento

**Description:** Implementar `POST /videos/:id/upload-complete` — completa o multipart no storage, muda o status para `processing` e enfileira o job de processamento.

**Technical actions:**

1. Adicionar `completeUpload(videoId, channelId, uploadId, parts)` ao `VideosService` — valida as partes, chama `completeMultipartUpload`, atualiza o status `draft → processing` e enfileira `video.processing.requested` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`, `phase-03-videos/TD-01`)
2. Criar `src/videos/dto/complete-upload.dto.ts` (`uploadId`, `parts[]`) com validação aninhada de class-validator
3. Adicionar `POST /videos/:id/upload-complete` ao `videos.controller.ts` (200)
4. Criar exceções `UploadNotInitiatedException` e `InvalidUploadPartsException`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: partes inválidas + Integration: real MinIO + Redis (job enfileirado) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- `upload-complete` válido retorna 200 com `status: 'processing'` e o job aparece na fila `video-processing`
- Sem upload iniciado retorna 409 `UPLOAD_NOT_INITIATED`
- Partes malformadas retornam 400 `INVALID_UPLOAD_PARTS`
- O objeto fica disponível no bucket `streamtube-videos` após a conclusão

---

### SI-03.6 — Fila de Processamento (BullMQ) e Bootstrap do Worker

**Description:** Configurar o `BullModule` (Redis), registrar a fila `video-processing` e criar um entrypoint de worker que sobe um contexto NestJS apenas com o consumidor — rodando em um serviço `worker` separado no Compose.

**Technical actions:**

1. Configurar `BullModule.forRootAsync` (connection vinda do `queue` config) e `BullModule.registerQueue({ name: VIDEO_QUEUE })` no `VideosModule` (per `phase-03-videos/TD-01`)
2. Criar `src/worker.ts` — bootstrap via `NestFactory.createApplicationContext(WorkerModule)` (sem servidor HTTP) (per `phase-03-videos/TD-04`)
3. Criar `src/worker.module.ts` — importa `ConfigModule`, `TypeOrmModule`, `StorageModule` e `VideosModule` (para o processor)
4. Adicionar o script `start:worker` (`node dist/worker.js`) ao `package.json`
5. Adicionar o serviço `worker` ao `compose.yaml` (mesma imagem, `command: npm run start:worker`, `depends_on` db/minio/redis)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `docker compose up` sobe o serviço `worker` sem expor HTTP
- O worker conecta ao Redis e registra o consumer da fila `video-processing`
- `npm run build` gera `dist/worker.js`

---

### SI-03.7 — Worker de Processamento (ffprobe + thumbnail + ciclo de status)

**Description:** Implementar o `VideoProcessor` que baixa o objeto, extrai duração/metadados com ffprobe, gera a thumbnail com ffmpeg, faz upload da thumbnail e atualiza o status para `ready` — ou `error` após esgotar as tentativas.

**Technical actions:**

1. Criar `src/videos/video.processor.ts` — `@Processor(VIDEO_QUEUE, { concurrency: 2 })`; baixa o objeto para um arquivo temporário, roda `ffprobe` (duração + metadata) e `.screenshots()` (thumbnail), faz upload da thumbnail e atualiza `status='ready'` + `duration_seconds` + `metadata` + `thumbnail_key` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
2. Configurar o job com `attempts: 3` e backoff exponencial; no evento `failed` (tentativas esgotadas), setar `status='error'` + `error_message` (per `phase-03-videos/TD-06`)
3. Instalar `ffmpeg`/`ffprobe` via apt no `Dockerfile.dev` (per `phase-03-videos/TD-05`)
4. Adicionar as constantes do job em `src/videos/videos.constants.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: real Redis + MinIO + FFmpeg (processa um vídeo pequeno, gera thumbnail, status → ready) | `src/videos/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Processar um vídeo válido gera a thumbnail no bucket `streamtube-thumbnails` e seta `status='ready'` com `duration_seconds`
- Um arquivo inválido esgota as tentativas e seta `status='error'` com `error_message`
- A thumbnail gerada é um JPEG legível

---

### SI-03.8 — Metadados do Vídeo e URL de Thumbnail

**Description:** Implementar `GET /videos/:id` retornando os metadados do vídeo e, quando `ready`, uma URL pré-assinada da thumbnail.

**Technical actions:**

1. Adicionar `getById(videoId, channelId)` ao `VideosService` (busca por id + canal; 404 quando ausente)
2. Criar `src/videos/dto/video-response.dto.ts` — mapeia a entidade para o contrato (`id`, `title`, `status`, `durationSeconds`, `metadata`, `thumbnailUrl`, `createdAt`, `updatedAt`)
3. Adicionar `GET /videos/:id` ao controller (200); quando `ready`, incluir `thumbnailUrl` via `presignGetObject(thumbnail_key)` (per `phase-03-videos/TD-03`)
4. Garantir a exceção `VideoNotFoundException`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getById` | Unit: not found + Integration: real DB | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.3

**Acceptance criteria:**

- `GET /videos/:id` do próprio canal retorna 200 com os metadados do vídeo
- Vídeo de outro canal retorna 404 `VIDEO_NOT_FOUND`
- Quando `ready`, `thumbnailUrl` é uma URL pré-assinada válida

---

### SI-03.9 — Streaming e Download (presigned GET + Range)

**Description:** Implementar `GET /videos/:id/stream` e `GET /videos/:id/download`, que emitem URLs pré-assinadas de GET (com suporte a Range) — streaming e download direto do storage, sem passar bytes pela API.

**Technical actions:**

1. Adicionar `getStreamUrl(videoId, channelId)` e `getDownloadUrl(videoId, channelId)` ao `VideosService` — exigem `status='ready'` (senão 409) e presignam o `source_key` (download com `Content-Disposition: attachment`) (per `phase-03-videos/TD-08`)
2. Adicionar `GET /videos/:id/stream` e `GET /videos/:id/download` ao controller (200 com `{ url }`)
3. Criar a exceção `VideoNotReadyException`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl/getDownloadUrl` | Unit: status ≠ ready + Integration: real MinIO (URL responde 206 com `Range`) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` retorna 200 com `{ url }`; a URL aceita header `Range` e responde 206
- `GET /videos/:id/download` retorna uma URL com `Content-Disposition: attachment`
- Vídeo não-`ready` retorna 409 `VIDEO_NOT_READY`

---

### SI-03.10 — Wiring do VideosModule, Autorização e OpenAPI

**Description:** Fechar o `VideosModule` (imports/providers/exports), garantir que os endpoints herdam o guard JWT global e documentar os endpoints com `@nestjs/swagger`.

**Technical actions:**

1. Completar `src/videos/videos.module.ts` — imports (`TypeOrmModule.forFeature([Video])`, `StorageModule`, `BullModule.registerQueue`), controllers e providers (`VideosService`, `VideoProcessor`)
2. Registrar `VideosModule` em `AppModule`
3. Anotar controllers/DTOs com `@ApiTags`/`@ApiOperation`/`@ApiResponse`/`@ApiProperty` (per `openapi-docs-nestjs/TD-01`)
4. Garantir que nenhum endpoint de vídeo usa `@Public()` (autorização herdada) (per `phase-02-auth/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4, SI-03.5, SI-03.7, SI-03.8, SI-03.9

**Acceptance criteria:**

- A aplicação sobe com o `VideosModule` registrado
- O `openapi.json` exportado inclui os 6 endpoints de vídeo com seus schemas
- Uma requisição sem token aos endpoints de vídeo retorna 401

---

### SI-03.11 — Documentação da Fase (CLAUDE.md seção de vídeos)

**Description:** Atualizar o CLAUDE.md do backend com a seção de vídeos (módulo, endpoints, fila/worker, storage), coerente com o código.

**Technical actions:**

1. Atualizar `nestjs-project/CLAUDE.md` — adicionar a seção de vídeos (módulo `videos/`, endpoints, fila `video-processing`, worker, buckets MinIO) e os novos serviços do Compose
2. Atualizar o `CLAUDE.md` da raiz — trocar `Message Queue (TBD)` por `BullMQ (Redis)` e refletir os containers reais (API, worker, MinIO, Redis)

**Tests:** _(empty — documentação)_

**Dependencies:** SI-03.10

**Acceptance criteria:**

- O CLAUDE.md cita apenas arquivos e comportamentos existentes (módulo `videos/`, fila, worker, storage)
- A arquitetura descrita bate com o `compose.yaml`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Also the public identifier used in URLs (TD-07) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (many-to-one) |
| title | varchar | not null | |
| status | enum | not null, values: `'draft'`, `'processing'`, `'ready'`, `'error'`, default `'draft'` | Lifecycle (TD-06) |
| source_key | varchar | not null | Storage key of the uploaded video object in `streamtube-videos` (TD-03) |
| thumbnail_key | varchar | nullable | Storage key of the generated thumbnail in `streamtube-thumbnails` (TD-03, TD-05) |
| duration_seconds | numeric | nullable | Extracted by the worker via ffprobe (TD-05) |
| metadata | jsonb | nullable | ffprobe format/stream metadata (codec, width, height, bitrate) |
| error_message | text | nullable | Populated when `status = 'error'` (TD-06) |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`)
**Indexes:** `(channel_id)` — FK; `(status)` — for querying videos by processing state

---

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- title: string, required — 1..200 characters

**Response 201:**
- id: string (uuid)
- title: string
- status: string (`draft`)
- createdAt: string (ISO-8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/upload-urls (SI-03.4)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- sizeBytes: number, required — total object size in bytes, must not exceed 10 GiB (10737418240)

**Response 200:**
- uploadId: string — S3 multipart upload id
- key: string — storage key of the source object in `streamtube-videos`
- partSize: number — part size in bytes
- parts: array of `{ partNumber: number, url: string }` — presigned PUT URL per part

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the requester
- 409 VIDEO_NOT_DRAFT: when the video is not in `draft` status
- 413 VIDEO_TOO_LARGE: when `sizeBytes` exceeds the 10 GiB limit
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/upload-complete (SI-03.5)

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- uploadId: string, required — the multipart upload id from `upload-urls`
- parts: array of `{ partNumber: number, eTag: string }`, required — the uploaded parts

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the requester
- 409 UPLOAD_NOT_INITIATED: when no multipart upload was started for the video
- 400 INVALID_UPLOAD_PARTS: when parts are missing or malformed
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/:id (SI-03.8)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- id: string (uuid)
- title: string
- status: string (`draft` | `processing` | `ready` | `error`)
- durationSeconds: number | null
- metadata: object | null
- thumbnailUrl: string | null — presigned GET URL (present when `status = ready`)
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the requester

---

#### GET /videos/:id/stream (SI-03.9)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- url: string — short-lived presigned GET URL for the source object; the client streams it directly from storage and may send HTTP `Range` headers (storage answers `206 Partial Content`)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the requester
- 409 VIDEO_NOT_READY: when the video is not in `ready` status

---

#### GET /videos/:id/download (SI-03.9)

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- url: string — short-lived presigned GET URL with `Content-Disposition: attachment` so the browser downloads the file

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or is not owned by the requester
- 409 VIDEO_NOT_READY: when the video is not in `ready` status

---

#### Validation Rules — Upload

| Field | Rule | Error message |
|-------|------|---------------|
| title | Required, 1..200 characters | title must be between 1 and 200 characters |
| sizeBytes | Required, integer, ≤ 10737418240 (10 GiB) | sizeBytes must not exceed 10GB |
| uploadId | Required, non-empty string | uploadId should not be empty |
| parts | Required, non-empty array of `{ partNumber ≥ 1, eTag non-empty }` | parts must contain at least one part |

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:id/upload-urls | ✗ | ✗ | ✓ |
| POST /videos/:id/upload-complete | ✗ | ✗ | ✓ |
| GET /videos/:id | ✗ | ✓ | ✓ |
| GET /videos/:id/stream | ✗ | ✓ | ✓ |
| GET /videos/:id/download | ✗ | ✓ | ✓ |

All video endpoints require a valid access token (global JWT guard, `@Public()` opt-out inherited from phase-02-auth). Anonymous/public viewing is a Fase 04 concern (video visibility: público/unlisted) and is intentionally out of scope here.

---

### Error Catalog

**Error response format:** inherited from phase-02-auth — `{ statusCode: number, error: string, message: string }`, where `error` carries the domain code below.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | The video id does not exist or does not belong to the requester's channel |
| VIDEO_NOT_DRAFT | 409 | Video is not a draft | `POST /videos/:id/upload-urls` on a video whose `status ≠ draft` |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET /videos/:id/stream` or `/download` on a video whose `status ≠ ready` |
| VIDEO_TOO_LARGE | 413 | File exceeds the 10GB limit | `POST /videos/:id/upload-urls` with `sizeBytes > 10 GiB` |
| UPLOAD_NOT_INITIATED | 409 | No upload in progress | `POST /videos/:id/upload-complete` without a prior `upload-urls` for the video |
| INVALID_UPLOAD_PARTS | 400 | Invalid upload parts | `POST /videos/:id/upload-complete` with missing or malformed parts |

---

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid", "sourceKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-04`)
**Trigger:** after `CompleteMultipartUpload` succeeds in `POST /videos/:id/upload-complete`
**Delivery semantics:** at-least-once — BullMQ queue `video-processing` (Redis-backed), 3 attempts with exponential backoff; exhausted attempts leave the video in `error` status with `error_message` set (per `phase-03-videos/TD-06`)

---

## Dependency Map

```
SI-03.1 (no deps)
SI-03.2 (no deps)

SI-03.1
├── SI-03.3
└── SI-03.6 (também depende de SI-03.2)

SI-03.2 + SI-03.3
└── SI-03.4
    ├── SI-03.5 (também depende de SI-03.6)
    └── SI-03.8
        └── SI-03.9

SI-03.6
└── SI-03.7

SI-03.4 + SI-03.5 + SI-03.7 + SI-03.8 + SI-03.9
└── SI-03.10
    └── SI-03.11
```

Linearized implementation order: SI-03.1, SI-03.2 (paralelo) → SI-03.3, SI-03.6 (paralelo) → SI-03.4 → SI-03.5, SI-03.8 (paralelo) → SI-03.7, SI-03.9 (paralelo) → SI-03.10 → SI-03.11

---

## Deliverables

- [ ] **SI-03.1** — Dependências, namespaces de configuração (`storage`, `queue`) e serviços MinIO + Redis no Compose
- [ ] **SI-03.2** — Entidade `Video` + migration `videos`
- [ ] **SI-03.3** — `StorageModule`/`StorageService` (cliente S3, buckets, presign multipart/GET)
- [ ] **SI-03.4** — `POST /videos` (rascunho) e `POST /videos/:id/upload-urls` (multipart presigned)
- [ ] **SI-03.5** — `POST /videos/:id/upload-complete` (completa o multipart + enfileira o processamento)
- [ ] **SI-03.6** — Fila BullMQ `video-processing` + serviço `worker` no Compose
- [ ] **SI-03.7** — `VideoProcessor` (ffprobe + thumbnail + ciclo de status)
- [ ] **SI-03.8** — `GET /videos/:id` (metadados + thumbnailUrl)
- [ ] **SI-03.9** — `GET /videos/:id/stream` e `/download` (presigned GET + Range)
- [ ] **SI-03.10** — Wiring do `VideosModule`, autorização e OpenAPI
- [ ] **SI-03.11** — CLAUDE.md atualizado com a seção de vídeos

**Suítes completas (`nestjs-project`):**

- [ ] Unit + integração: `docker compose exec nestjs-api npm test -- --runInBand`
- [ ] E2E: `docker compose exec nestjs-api npm run test:e2e`
- [ ] Type-check: `docker compose exec nestjs-api npx tsc --noEmit`
- [ ] Lint: `docker compose exec nestjs-api npm run lint`
- [ ] Build: `docker compose exec nestjs-api npm run build`
- [ ] Upload de 10GB, processamento automático, thumbnail, URL única, streaming e download funcionando de ponta a ponta
