---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-03
scope_description: "Video upload & processing foundation: background job queue, direct-to-storage 10GB upload, object storage SDK/layout, worker execution, FFmpeg media processing, video lifecycle status, unique URL and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, upload orchestration, storage client, queue producer), the video worker (queue consumer + FFmpeg) and the new infra in `compose.yaml` (MinIO, Redis, worker). All TDs below land here.
- `next-frontend/` — frontend deferred (video UI is not part of this phase's scope). No open decision here, but TD-02 (upload protocol) and TD-08 (streaming/download delivery) fix the client↔storage contract now so the future player/uploader consumes it unchanged.

---

## TD-01: Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan and architecture diagram leave the queue open ("Message Queue (TBD)"). The worker must consume video-processing jobs (probe metadata, thumbnail) with retry/backoff so the status lifecycle (TD-06) behaves predictably. The queue must run self-hosted in Docker Compose and be usable in production.

**Options:**

### Option A: BullMQ + Redis
- Redis-backed job queue; BullMQ is the de-facto Node queue with retries, backoff, delayed jobs, concurrency and stalled-job detection built in. The official `@nestjs/bullmq` module (v11.x) integrates it with NestJS 11 via `BullModule` + `@Processor`/`WorkerHost`.
- **Pros:** Official NestJS 11 integration; retry/backoff/delay/concurrency covered out of the box; self-hosted via a single Redis container; battle-tested at scale.
- **Cons:** Adds a Redis container to the stack; durability depends on Redis persistence (acceptable for local/self-hosted).

### Option B: RabbitMQ (AMQP)
- Full-featured message broker (durable queues, dead-letter exchanges, multi-consumer patterns) running in its own Erlang container.
- **Pros:** Rich broker semantics; durable by default; native DLQ for poison jobs.
- **Cons:** Heavier container + ops (Erlang VM); no first-class NestJS job-queue DSL — needs `amqplib` plus hand-rolled worker, retry and scheduling logic; overkill for a single queue.

### Option C: AWS SQS
- Fully managed queue; the classic cloud choice for decoupling.
- **Pros:** Managed, scales to zero, no broker to operate.
- **Cons:** Requires AWS credentials even in dev (would force LocalStack or a second infra path); polling latency; needs an adapter for NestJS; wrong fit for a self-hosted Compose stack.

### Option D: pg-boss (Postgres-backed)
- Job queue stored in PostgreSQL; reuses the existing `db` service, no new container.
- **Pros:** Zero new infrastructure; transactional with the DB; retries/scheduling supported.
- **Cons:** Couples job throughput and lock contention to the primary DB; no official NestJS module (manual provider); fewer rich features than BullMQ.

**Recommendation:** **A (BullMQ + Redis)** — matches a self-hosted Docker Compose stack, has the official NestJS 11 integration, and its built-in retries/backoff/concurrency cover exactly what the worker and the status lifecycle need, at the cost of one Redis container.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Large-File Upload Strategy (10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** S3 single-object PUT is capped at 5GB, so a 10GB upload must be multipart. The API must never hold the file bytes (memory/bandwidth bottleneck and request time would "travar o sistema"). The flow is: client requests a draft → API initializes an S3 multipart upload and returns presigned part URLs → client uploads parts straight to storage → client completes → API verifies, completes the multipart upload and enqueues the processing job. The same contract fixes the future frontend's uploader.

**Options:**

### Option A: Presigned multipart upload (direct to storage)
- API calls S3 `CreateMultipartUpload`, presigns each part URL; the client PUTs parts (e.g., 100–200MB each → 50–100 parts for 10GB) directly to MinIO/S3, then the API calls `CompleteMultipartUpload`.
- **Pros:** 10GB never traverses the API; parts can upload in parallel; resumable per part; scales with object storage; matches the intended direct-to-storage architecture.
- **Cons:** Client orchestrates many part requests; the API must track multipart upload state (`upload_id`, parts).

### Option B: tus resumable upload protocol
- A tus server (e.g., `tus-node-server` with an S3 store) exposes the standard resumable protocol; the client streams with pause/resume.
- **Pros:** True pause/resume for flaky connections; standardized protocol (many client libs).
- **Cons:** Adds a whole extra service/component; per-request overhead; resume is not a stated requirement of this phase — heavier than needed.

### Option C: Chunked upload proxied through the API
- The client uploads chunks to the API, which streams each chunk to storage.
- **Pros:** Simplest client; no presigned orchestration.
- **Cons:** All 10GB still flows through the API (bandwidth, memory, single point of failure); fails the "sem travar a API" requirement in spirit and contradicts the direct-to-storage architecture.

**Recommendation:** **A (presigned multipart)** — direct-to-storage keeps the API free during the transfer (the phase's core requirement) and multipart is mandatory for anything over 5GB.

**Decision:** A (Presigned multipart)

---

## TD-03: Object Storage SDK & Bucket Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend is not open for debate — S3-compatible, running as MinIO locally and swappable to AWS S3 in production. Open choices are which client SDK the app uses and how buckets/keys are organized; both ripple into Compose env, app config and the worker.

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- Official AWS SDK v3 S3 client with the request presigner for part/object URLs.
- **Pros:** Canonical S3 API; swapping to AWS S3 in prod is only an endpoint/credential config change; mature multipart + Range support; strong presigner.
- **Cons:** Verbose API surface; heavier dependency tree.

### Option B: `minio-js` (MinIO JavaScript client)
- MinIO's official client with high-level `presignedPutObject`/`presignedGetObject` and built-in multipart for server-side puts.
- **Pros:** Simple, purpose-built API; works against any S3-compatible service.
- **Cons:** MinIO-specific idioms in app code; less canonical if the project later runs on AWS S3.

**Recommendation:** **A (`@aws-sdk/client-s3`)** — the phase explicitly anticipates swapping to AWS S3 in production; using the AWS SDK keeps app code provider-agnostic while the endpoint simply points at MinIO locally. Bucket layout (implementation detail resolved in the plan): two buckets — `streamtube-videos` and `streamtube-thumbnails` — with opaque keys (`videos/{videoId}/{uuid}.mp4`, `thumbnails/{videoId}.jpg`), created/ensured on API startup.

**Decision:** A (@aws-sdk/client-s3)

---

## TD-04: Video Worker Execution Model

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram already models the worker as its own container. Open is how that container runs: reuse the API image with a different entrypoint, or a dedicated image — and how the consumer bootstraps so it does not start the HTTP server.

**Options:**

### Option A: Dedicated `worker` Compose service reusing the API image
- A `worker` service in `compose.yaml` built from the same `Dockerfile.dev`, launched with a distinct command that boots only the BullMQ consumer and its dependencies (e.g., `node dist/worker-main.js`).
- **Pros:** Isolated crash domain from the HTTP API; one build/codebase, no drift; easy to scale independently.
- **Cons:** The image carries API code it does not need (size, not correctness).

### Option B: Worker inside the API process
- The BullMQ `Worker` runs within the same NestJS process/container as the HTTP server.
- **Pros:** Zero extra container.
- **Cons:** FFmpeg CPU work competes with HTTP latency; cannot scale separately; contradicts the architecture diagram's separate worker container.

### Option C: Dedicated worker image (separate Dockerfile)
- A leaner image containing only the worker entrypoint.
- **Pros:** Smallest image; clear separation.
- **Cons:** Duplicated build pipeline; Dockerfile/maintenance drift between API and worker images.

**Recommendation:** **A (separate `worker` service reusing the API image)** — matches the architecture diagram, isolates FFmpeg load from the API, and avoids a second build to maintain.

**Decision:** A (Separate worker service, shared image)

---

## TD-05: Media Processing Tooling (FFmpeg)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and format metadata (`ffprobe`) and generate a thumbnail from a frame (`ffmpeg`). Open: how the FFmpeg binaries reach the worker image and which wrapper library the code uses.

**Options:**

### Option A: System FFmpeg (apt) + `fluent-ffmpeg`
- Install `ffmpeg`/`ffprobe` in the worker image via apt; wrap calls with the `fluent-ffmpeg` library (`ffmpeg.ffprobe()` for metadata, `.screenshots()` for the thumbnail).
- **Pros:** Official FFmpeg binaries, always current; ergonomic ffprobe + thumbnail API; matches the diagram's "Video Worker (FFmpeg)".
- **Cons:** apt install grows the image; rebuilding the image updates FFmpeg.

### Option B: Bundled binaries (`ffmpeg-static` / `@ffmpeg-installer`)
- Ship pinned platform binaries through npm packages.
- **Pros:** Pinned versions; no apt in the image.
- **Cons:** Large platform-specific binaries in the dependency tree; glibc/runtime pitfalls; `ffprobe` needs a separate package; version drift between binary and lib.

### Option C: Direct `child_process` spawn of ffmpeg/ffprobe
- No wrapper library; parse ffprobe JSON and manage ffmpeg invocations manually.
- **Pros:** No extra npm dependency.
- **Cons:** Hand-rolled JSON parsing, process/error handling and temp-file management — more code to maintain and test.

**Recommendation:** **A (system FFmpeg + `fluent-ffmpeg`)** — keeps the worker image self-contained with official binaries and gives an ergonomic, well-documented API for the two required tasks (metadata + thumbnail).

**Decision:** A (System FFmpeg + fluent-ffmpeg)

---

## TD-06: Video Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** A video moves through a status cycle and the DB, API contract and worker must agree on transitions — including what happens when processing fails. The requirement names the cycle "rascunho → processando → pronto/erro".

**Options:**

### Option A: Linear lifecycle `draft → processing → ready | error` with BullMQ retries
- Draft is created at upload start; becomes `processing` when the job is enqueued; worker success → `ready` (duration/metadata/thumbnail stored); worker failure after BullMQ retries (e.g., 3 attempts with backoff) → terminal `error`, source object kept for later re-processing.
- **Pros:** Simple, predictable, matches the required cycle; retries handled by the queue; recovery possible (re-enqueue) without losing the upload.
- **Cons:** A permanently broken job needs a manual/API re-process trigger (acceptable; surfaced in Fase 04).

### Option B: Enriched state machine + DLQ
- Adds states/DLQ for poison-job isolation.
- **Pros:** Stronger failure isolation for pathological inputs.
- **Cons:** More states and infra to build, test and document; not justified by this phase's requirements.

### Option C: Delete video on processing failure
- Simplest possible failure path.
- **Pros:** No error state to manage.
- **Cons:** Destroys the user's upload; conflicts with the required `erro` state; poor UX.

**Recommendation:** **A (linear lifecycle + BullMQ retries + terminal error)** — satisfies the required cycle exactly, uses the queue's built-in retries, and keeps the source file so a re-process can be added later without data loss.

**Decision:** A (Linear lifecycle + retries + error)

---

## TD-07: Unique Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier that never collides with any other video and becomes the canonical URL (`/videos/{id}`). It must not leak unpublished drafts via enumeration and must survive renames.

**Options:**

### Option A: Opaque UUID (the entity's primary key)
- The `videos.id` UUID is the public identifier used in routes and storage URLs.
- **Pros:** Guaranteed uniqueness; no enumeration of unlisted videos; zero extra column or generation logic.
- **Cons:** Long, not human-readable/SEO-friendly.

### Option B: Human-friendly slug from the title
- E.g., `/videos/how-to-stream-in-5-minutes`.
- **Pros:** Readable, SEO-friendly.
- **Cons:** Collision handling (suffix strategy), title changes break URLs, uniqueness constraint + migration logic; premature for this phase.

### Option C: Random short code (e.g., nanoid/base62)
- A compact, opaque identifier separate from the PK.
- **Pros:** Short and collision-improbable.
- **Cons:** Extra column and generation code; less debuggable than a UUID.

**Recommendation:** **A (UUID)** — guaranteed uniqueness with zero extra machinery; SEO-friendly slugs can be layered on in Fase 04 (video/channel management) without a URL-breaking migration now.

**Decision:** A (Opaque UUID)

---

## TD-08: Streaming & Download Delivery

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The architecture diagram already has the frontend streaming directly from object storage. Open is the delivery mechanism: presigned URLs straight from storage (native HTTP Range/206) versus proxying the bytes through the API, and how download is expressed.

**Options:**

### Option A: Presigned GET URLs direct from storage (HTTP Range/206)
- The API, after auth, mints a short-lived presigned GET URL for the source object; the client streams it directly from MinIO/S3 (native Range requests → 206 Partial Content). Download uses the same presigned URL with a `response-content-disposition=attachment` override.
- **Pros:** Zero API bandwidth for playback; native Range/206 from object storage; matches the diagram.
- **Cons:** Presigned URL TTL management; authorization happens at URL-mint time, not per byte.

### Option B: Proxy streaming through the API
- The API pipes storage→client with Range passthrough.
- **Pros:** Per-request auth; no presigned TTL.
- **Cons:** The API becomes the bandwidth bottleneck for every play/download — defeats the 10GB goal; contradicts the diagram's direct frontend↔storage stream.

**Recommendation:** **A (presigned GET with Range/206)** — keeps the API out of the media path entirely, leverages native object-storage Range support, and expresses download as an attachment-disposition presigned URL.

**Decision:** A (Presigned GET + Range/206)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Queue Technology | A (BullMQ + Redis) | **A (BullMQ + Redis)** |
| TD-02 | Cross-layer | Large-File Upload Strategy | A (Presigned multipart) | **A (Presigned multipart)** |
| TD-03 | Backend | Object Storage SDK & Bucket Layout | A (@aws-sdk/client-s3) | **A (@aws-sdk/client-s3)** |
| TD-04 | Repo-wide | Video Worker Execution Model | A (Separate worker service, shared image) | **A (Separate worker service)** |
| TD-05 | Backend | Media Processing Tooling | A (System FFmpeg + fluent-ffmpeg) | **A (System FFmpeg + fluent-ffmpeg)** |
| TD-06 | Backend | Video Lifecycle & Failure Handling | A (Linear lifecycle + retries + error) | **A (Linear lifecycle + retries + error)** |
| TD-07 | Backend | Unique Video URL Strategy | A (Opaque UUID) | **A (Opaque UUID)** |
| TD-08 | Cross-layer | Streaming & Download Delivery | A (Presigned GET + Range/206) | **A (Presigned GET + Range/206)** |
