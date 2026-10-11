# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/11 completed

### SI-03.1 — Dependências, Namespaces de Configuração e Infra no Compose
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - **Desvio de plano (aprovado pelo usuário):** `minio/minio` não é puxável neste host (Docker Hub e quay.io exigem auth). Usada `ghcr.io/chainguard-images/minio:latest-dev` — MinIO real (open-source). Os ACs continuam atendidos: S3 em `:9000`, console em `:9001` (HTTP 200) e `minio healthy`.
  - Adicionado `user: "0"` ao serviço minio: o volume nomeado nasce root-owned e a imagem roda como uid 65532, o que quebra a escrita em `/data` (`file access denied`).
  - Healthcheck usa `wget`: a tag runtime `latest` é distroless (sem shell/curl); `latest-dev` traz `wget`.
  - Versão do MinIO na imagem é `DEVELOPMENT.2023-04-13` (último build AGPL open-source) — antiga, mas com multipart/presign/Range disponíveis.
  - `REDIS_HOST_PORT=6380` no `.env` (6379 reservada pela stack local); `S3_*`/`REDIS_*` adicionados ao `.env` (gitignored) além do `.env.example`.
  - `fluent-ffmpeg` instalado sem `@types/fluent-ffmpeg` (não previsto no plano) — pode ser necessário quando o SI-03.7 importar a lib.
  - ACs verificados: `tsc --noEmit` exit 0; E2E `GET /` 200; Joi rejeita a ausência de `S3_ACCESS_KEY`/`S3_SECRET_KEY`.

### SI-03.2 — Entidade Video e Migration
- **Status:** completed
- **Tests:** 9/9 passing (video.entity.integration-spec.ts: 8, videos.module.spec.ts: 1); `tsc --noEmit` exit 0
- **Observations:**
  - Relação definida **só no lado owning** (`@ManyToOne`), como o plano especifica. Não adicionei o `@OneToMany` inverso em `Channel` (regra `nestjs-entities.md` pede os dois lados): isso obrigaria a incluir `Video` em todos os `DataSource` de teste que já passam arrays explícitos de entidades (channel/users/auth specs), um blast radius fora do escopo do SI. Decisão a confirmar com o usuário.
  - Estendido o helper compartilhado `cleanAllTables` (`src/test/create-test-data-source.ts`) para deletar `videos` antes de `channels` (FK), com guarda `to_regclass` — a tabela só existe nos DataSources que registram `Video`.
  - `title` como `varchar(200)`: o Data Model diz só "varchar"; usei 200 para casar com a Validation Rule (1..200).
  - `duration_seconds` (`numeric`) com transformer para `number` — o driver `pg` devolve `numeric` como string.
  - DB de dev estava vazio (volume novo): rodei `migration:run` das 2 migrations existentes antes de `migration:generate`, para o diff conter apenas `videos`.
  - Migration `1791742780402-CreateVideos`: enum `videos_status_enum`, tabela, índices em `channel_id`/`status`, FK para `channels`; o `down()` também dropa o tipo enum.

### SI-03.3 — Módulo de Storage (cliente S3, buckets e presign)
- **Status:** completed
- **Tests:** 5/5 passing (storage.service.integration-spec.ts — MinIO real); `tsc --noEmit` exit 0
- **Observations:**
  - Registrei `storageConfig` no array `load` do `ConfigModule` em `AppModule`: o SI-03.1 criou o namespace mas não o registrou, e `@Inject(storageConfig.KEY)` exige o registro. (`queueConfig` fica para o SI-03.6.)
  - `StorageService` cria e mantém o próprio `S3Client` a partir do config; `StorageModule` é `@Global` e implementa `OnModuleInit` → `ensureBuckets()`, como o plano pede.
  - `ensureBucket` só cria em 404/NotFound; outros erros propagam (evita mascarar falha de conexão como erro de criação).
  - `presignGetObject` usa o bucket de vídeos (assinatura do plano, sem parâmetro de bucket). O SI-03.8 provavelmente vai precisar de uma variante para o bucket de thumbnails (`thumbnailUrl`).
  - O teste de integração constrói o próprio `S3Client` para verificação/cleanup (não usa o SUT para se verificar) e apaga os buckets antes de recriar, para exercitar o caminho de criação.
  - ACs validados contra MinIO real (imagem Chainguard do SI-03.1).

### SI-03.4 — Pré-cadastro de Vídeo e Início do Upload Multipart
- **Status:** pending
- **Tests:** pending

### SI-03.5 — Conclusão do Upload Multipart e Enfileiramento
- **Status:** pending
- **Tests:** pending

### SI-03.6 — Fila de Processamento (BullMQ) e Bootstrap do Worker
- **Status:** completed
- **Tests:** 1/1 passing (worker.module.spec.ts); `tsc --noEmit` exit 0; `npm run build` gera `dist/worker.js`
- **Observations:**
  - **Lacuna de plano corrigida:** `ioredis` não estava instalado — o `bullmq` v6 carrega `ioredis` como peer opcional e o `BullModule` falha com "BullMQ could not load the optional 'ioredis' package". Instalado `ioredis@^5.11.1` (bullmq resolveu para `^6.3.12`).
  - `BullModule.forRootAsync` + `registerQueue` ficaram no `VideosModule` conforme o plano — incomum (o `forRoot` costuma morar no módulo raiz), mas necessário para que o `WorkerModule` receba a conexão via `VideosModule`.
  - `WorkerModule` duplica o `ConfigModule.forRoot` e o `TypeOrmModule.forRootAsync` do `AppModule`. Sugestão de follow-up: extrair módulos compartilhados (ex.: `RootConfigModule` + `DatabaseModule`) para evitar drift entre API e worker.
  - `WorkerModule` também importa `UsersModule` (além dos 4 módulos listados no plano): sem isso o TypeORM não resolve a metadata da relação `Video → Channel` ("Entity metadata for Video#channel was not found") e o worker não sobe. `UsersModule` traz `ChannelsModule` junto.
  - `queueConfig` também registrado no `load` do `AppModule` (o `VideosModule` só entra no `AppModule` no SI-03.10, mas o registro fica pronto).
  - `command: npm run start:worker` roda `node dist/worker.js` conforme o plano — exige `dist/` existente (um `npm run build` prévio). Num clone limpo, sem `dist/`, o container do worker quebra no boot; fragilidade do compose de dev, anotada.
  - ACs verificados: worker sobe **sem portas publicadas**; conecta ao Redis (chave `bull:video-processing:meta` presente); `dist/worker.js` gerado. O **consumer** (processor) só é registrado no SI-03.7.

### SI-03.7 — Worker de Processamento (ffprobe + thumbnail + ciclo de status)
- **Status:** pending
- **Tests:** pending

### SI-03.8 — Metadados do Vídeo e URL de Thumbnail
- **Status:** pending
- **Tests:** pending

### SI-03.9 — Streaming e Download (presigned GET + Range)
- **Status:** pending
- **Tests:** pending

### SI-03.10 — Wiring do VideosModule, Autorização e OpenAPI
- **Status:** pending
- **Tests:** pending

### SI-03.11 — Documentação da Fase (CLAUDE.md seção de vídeos)
- **Status:** pending
- **Tests:** pending
