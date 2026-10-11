# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/11 completed

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
- **Status:** completed
- **Tests:** 21/21 passing (videos.service.integration-spec.ts: 7, videos.module.spec.ts: 1, videos.e2e-spec.ts: 13); `tsc --noEmit` exit 0
- **Observations:**
  - **Inconsistência de plano resolvida:** a tabela "Validation Rules — Upload" lista `sizeBytes ≤ 10 GiB` como regra de validação (400), mas o Error Catalog e o AC exigem **413 `VIDEO_TOO_LARGE`** para a mesma condição — só um pode disparar. Honrei o Error Catalog + AC (413): o DTO valida apenas `@IsInt()`/`@Min(1)` e o limite de 10 GiB é checado no service. **Confirmar com o usuário.**
  - `@Min(1)` no `sizeBytes` não está na regra documentada; adicionado para rejeitar 0/negativo.
  - Adicionado `ChannelsService.findByUserId` (não existia lookup de canal): usa `dataSource.getRepository(Channel)` para não alterar o construtor do service (e portanto não quebrar os testes existentes de channels).
  - Adicionado `ChannelNotFoundException` em `src/common/exceptions/domain.exception.ts` (lar estabelecido das exceções de domínio) para o caso invariante "usuário autenticado sem canal" — não estava na lista de exceções do plano.
  - As 3 exceções de vídeo ficaram em `src/videos/exceptions/video.exception.ts` conforme o plano; notar que a convenção existente do projeto mantém todas as exceções em `common/exceptions/domain.exception.ts` — agora há dois locais.
  - `ParseUUIDPipe` no `:id` (não previsto no plano): id malformado retorna 400 em vez de 500 do Postgres.
  - `videos.module.spec.ts` atualizado para espelhar os registros globais do app (`ConfigModule` com `queueConfig` + `storageConfig`, `StorageModule`) — sem isso o `StorageService` não resolve.
  - O E2E importa `[AppModule, VideosModule]` porque o `VideosModule` só entra no `AppModule` no SI-03.10.
  - `source_key` é gerado no pré-cadastro (`videos/{videoId}/{uuid}.mp4`, layout do TD-03) porque a coluna é NOT NULL.
  - O teste E2E do caminho feliz de `upload-urls` deixa um multipart upload incompleto no MinIO (não há helper de abort) — sujeira menor de dev.

### SI-03.5 — Conclusão do Upload Multipart e Enfileiramento
- **Status:** completed
- **Tests:** 34/34 passing (videos.service.integration-spec.ts: 13, videos.module.spec.ts: 1, videos.e2e-spec.ts: 20); `tsc --noEmit` exit 0
- **Observations:**
  - **`UPLOAD_NOT_INITIATED` sem coluna de upload_id:** a entidade não tem coluna `upload_id` (Data Model), então não há sinal persistido de "upload iniciado". A detecção é feita no storage: `CompleteMultipartUpload` com uploadId desconhecido/abortado → S3/MinIO devolve `NoSuchUpload` → mapeado para 409. Verificado empiricamente (MinIO devolve `NoSuchUpload` tanto para uploadId aleatório quanto para um abortado).
  - Caveat: o helper `isNoSuchUpload` também trata um 404 genérico como `NoSuchUpload` (ex.: bucket inexistente viraria 409 em vez de erro). Risco baixo neste setup, mas anotado.
  - Job enfileirado com nome `process` e opções `attempts: 3` + backoff exponencial 5000 ms (TD-06 / library-refs); payload `{ videoId, sourceKey }` conforme Events/Messages.
  - **Extensão além do plano:** adicionei os casos de `upload-complete` ao `test/videos.e2e-spec.ts`, embora a tabela de Tests do SI-03.5 liste apenas o spec do service. Justificativa: os ACs são HTTP-level (200/409/400) e o guia de testes exige um teste de wiring de validação por endpoint.
  - O spec do service passou a importar o `VideosModule` (precisa do provider real da fila) e faz `queue.drain()` no `beforeEach`.

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
- **Status:** completed
- **Tests:** 51/51 passing (video.processor.integration-spec.ts: 2, videos.service.integration-spec.ts, storage.service.integration-spec.ts, videos.module.spec.ts, worker.module.spec.ts, videos.e2e-spec.ts); `tsc --noEmit` exit 0
- **Observations:**
  - **Processor registrado no `WorkerModule`, não no `VideosModule`** (desvio da redação do plano): o SI-03.6 dizia que o `WorkerModule` importa "VideosModule (para o processor)", o que faria o processor ser provider do `VideosModule` — e aí a **API também consumiria jobs** (quando o `VideosModule` entrar no `AppModule` no SI-03.10), além de todo `app.init()` em teste subir um consumer. Registrando no `WorkerModule`, a API fica livre. Exigiu adicionar `exports: [TypeOrmModule]` ao `VideosModule` (mesmo padrão de `ChannelsModule`/`UsersModule`) para o worker injetar o repositório de `Video`.
  - **Tratamento de falha:** o `WorkerHost` do `@nestjs/bullmq` **não tem** hook `onFailed` (só `process`); usei `@OnWorkerEvent('failed')`, marcando `status='error'` + `error_message` apenas quando `job.attemptsMade >= job.opts.attempts` (verificado empiricamente com `attempts: 1`).
  - Instalado `@types/fluent-ffmpeg` (devDependency) — era a lacuna sinalizada no SI-03.1; sem ela o `tsc` falha no import do fluent-ffmpeg.
  - ffmpeg/ffprobe instalados via `Dockerfile.dev` (`apt install -y procps curl ffmpeg`) → ffmpeg 5.1.9.
  - `StorageService` ganhou `downloadObjectToFile` (stream para arquivo temporário — um vídeo de 10 GB não cabe em Buffer) e `uploadThumbnail`.
  - Thumbnail extraída no timestamp de `1s`: um vídeo com duração < 1s falharia. Limitação anotada.
  - O `tsc` pegou um problema real: `repository.update()` não tipa coluna `jsonb` (`_QueryDeepPartialEntity`) → o caminho de sucesso passou a carregar a entidade e usar `save()`, como no `VideosService`.
  - Extraído `src/test/s3-test-client.ts` (o client S3 de teste estava sendo triplicado entre specs).
  - **Caveat operacional:** parar o serviço `worker` ao rodar a suíte — ele consome as jobs enfileiradas pelos testes e corre com as asserções de status. Verifiquei que o container funciona de ponta a ponta (pegou uma job residual e rodou o ffprobe nela). Deixei o container **parado**.
  - A asserção de job no spec do SI-03.5 agora consulta todos os estados (robusta a um consumer vivo).

### SI-03.8 — Metadados do Vídeo e URL de Thumbnail
- **Status:** completed
- **Tests:** 48/48 passing (videos.service.integration-spec.ts, storage.service.integration-spec.ts, videos.module.spec.ts, videos.e2e-spec.ts); `tsc --noEmit` exit 0
- **Observations:**
  - Adicionado `StorageService.presignGetThumbnail`: a assinatura de `presignGetObject` do SI-03.3 só cobria o bucket de vídeos, e o SI-03.8 precisa assinar o bucket de thumbnails. Optei por um método dedicado (em vez de expor o nome do bucket ao `VideosService`); o presign comum foi extraído para um `presignGet` privado. Isso é a mudança de interface que eu já havia sinalizado no SI-03.3.
  - `VideosService.getById` retorna o `VideoResponseDto` já montado (a `thumbnailUrl` exige presign assíncrono, que é responsabilidade do service).
  - **Extensão além do plano:** adicionei casos de `GET /videos/:id` ao `test/videos.e2e-spec.ts`, embora a tabela de Tests do SI-03.8 liste apenas o spec do service — os ACs são HTTP-level. Mesma justificativa do SI-03.5.

### SI-03.9 — Streaming e Download (presigned GET + Range)
- **Status:** completed
- **Tests:** 57/57 passing (videos.service.integration-spec.ts, videos.module.spec.ts, videos.e2e-spec.ts); `tsc --noEmit` exit 0
- **Observations:**
  - `getStreamUrl`/`getDownloadUrl` retornam `{ url }`; o controller é pass-through.
  - Helper privado `requireReadyVideo` compartilhado pelos dois: 404 (não existe / não é do canal) antes do 409 (não está `ready`).
  - A URL de download usa a opção `download: true` do `presignGetObject` (existia desde o SI-03.3, mas só era exercitada indiretamente) — agora verificada por comportamento: o `fetch` na URL devolve o header `Content-Disposition: attachment`.
  - **Extensão além do plano:** casos de `stream`/`download` adicionados ao `test/videos.e2e-spec.ts` (a tabela de Tests do SI-03.9 lista só o spec do service) — mesma justificativa dos SIs anteriores.

### SI-03.10 — Wiring do VideosModule, Autorização e OpenAPI
- **Status:** pending
- **Tests:** pending

### SI-03.11 — Documentação da Fase (CLAUDE.md seção de vídeos)
- **Status:** pending
- **Tests:** pending
